#!/usr/bin/env node
/**
 * AIXX MCP Server (zero-dependency, stdio)
 * Base: https://baodan.run/v1  (OpenAI-compatible)
 *
 * Tools:
 *   aixx_list_models   - 列出在架文本模型(实时拉 /v1/models,带缓存)
 *   aixx_chat          - 对话补全(POST /v1/chat/completions)
 *   aixx_image         - 出图(POST /v1/media/image,AIXX扩展)
 *   aixx_video         - 出视频(POST /v1/media/video,AIXX扩展,异步)
 *   aixx_task          - 轮询媒体任务(GET /v1/media/task/{id})
 *
 * 鉴权: 优先用工具参数 apiKey,其次环境变量 AIXX_API_KEY。
 * Key 格式: sk- + 16-128位字母数字。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.AIXX_BASE_URL || 'https://baodan.run/v1';
const ENV_KEY = process.env.AIXX_API_KEY || '';

// 版本号从同目录 package.json 读取,避免与包版本脱节(npx 场景下包以目录形式存在,__dirname/package.json 必在)。
let VERSION = 'unknown';
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || VERSION;
} catch { /* 保持 fallback */ }

let modelCache = null;
let modelCacheAt = 0;
const MODEL_TTL_MS = 5 * 60 * 1000;

// ---------- stdio JSON-RPC (NDJSON) ----------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try { handle(JSON.parse(line)); } catch (e) { /* ignore malformed */ }
    }
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

// ---------- tool definitions ----------
const TOOLS = [
  {
    name: 'aixx_list_models',
    description: '列出 AIXX 当前在架的文本大模型(实时从 /v1/models 拉取,5分钟缓存)。返回模型 id、厂牌、支持的端点类型。图像/视频模型为固定清单,见各自工具说明。',
    inputSchema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'AIXX API Key (sk-开头)。不传则用环境变量 AIXX_API_KEY。' },
        force_refresh: { type: 'boolean', description: 'true 时跳过缓存强制重新拉取。', default: false }
      }
    }
  },
  {
    name: 'aixx_chat',
    description: '调用 AIXX 对话补全(OpenAI 兼容)。支持全部在架文本模型(Claude/GPT/Gemini/DeepSeek/Qwen/GLM 等),支持 SSE 流式但本工具返回完整文本。注意:推理模型(如 deepseek-v4-pro)会消耗 token 用于思考,max_tokens 要给足。',
    inputSchema: {
      type: 'object',
      required: ['messages'],
      properties: {
        model: { type: 'string', description: '模型 id,如 claude-sonnet-4-6、deepseek-v4-pro、gpt-5.5。用 aixx_list_models 查在架列表。' },
        messages: {
          type: 'array',
          description: '对话消息数组,每条 {role: user|assistant|system, content: string}',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string' },
              content: { type: 'string' }
            }
          }
        },
        max_tokens: { type: 'integer', description: '最大生成 token 数。推理模型建议 >=500。', default: 1024 },
        temperature: { type: 'number', description: '采样温度 0-2。' },
        apiKey: { type: 'string', description: 'AIXX API Key,不传则用环境变量。' }
      }
    }
  },
  {
    name: 'aixx_image',
    description: 'AIXX 出图(扩展端点 /v1/media/image)。模型: gpt-image-2(-lite)、nano-banana-pro、seedream、midjourney 等;不传 model 自动挑最便宜可用。同步等 <=90s 直接出图,超时返回 task_id 可用 aixx_task 轮询。',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '图像描述。' },
        model: { type: 'string', description: '出图模型 id,可省略=自动选最便宜。' },
        size: { type: 'string', description: '比例字符串: 9:16 / 1:1 / 16:9 等,不是像素。', default: '1:1' },
        apiKey: { type: 'string' }
      }
    }
  },
  {
    name: 'aixx_video',
    description: 'AIXX 出视频(扩展端点 /v1/media/video,异步)。模型: minimax-h3、veo-3.1、kling、seedance 等。提交后立即返回 task_id,用 aixx_task 轮询 status/progress/result_url。失败自动退款。限速 5次/分钟/Key。',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '视频描述。' },
        model: { type: 'string', description: '视频模型 id,如 minimax-h3。', default: 'minimax-h3' },
        duration: { type: 'integer', description: '时长 5-15 秒。', default: 5, minimum: 5, maximum: 15 },
        resolution: { type: 'string', description: '480p 或 720p。', default: '480p', enum: ['480p', '720p'] },
        apiKey: { type: 'string' }
      }
    }
  },
  {
    name: 'aixx_task',
    description: '轮询 AIXX 媒体任务(GET /v1/media/task/{task_id})。返回 status / progress / result_url。用于出图(超时时)和出视频。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'aixx_image/aixx_video 返回的 task_id。' },
        apiKey: { type: 'string' }
      }
    }
  }
];

// ---------- handler ----------
async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aixx-mcp', version: VERSION }
      });
    }
    if (method === 'notifications/initialized') return; // no response
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') return await callTool(id, params);
    return replyError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return replyError(id, -32603, e && e.message ? e.message : String(e));
  }
}

async function callTool(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const key = args.apiKey || ENV_KEY;
  if (!key) {
    return toolResult(id, '缺少 AIXX API Key。请在连接器环境变量设置 AIXX_API_KEY,或在调用时传 apiKey 参数。注册并领取 Key: https://baodan.run/console/ (新用户送 ¥5,登录后在「令牌」页生成 sk- key)。', true);
  }
  if (!/^sk-[A-Za-z0-9]{16,128}$/.test(key)) {
    return toolResult(id, 'API Key 格式不对:应为 sk- + 16-128位字母数字(不要含连字符等符号)。', true);
  }

  try {
    if (name === 'aixx_list_models') return await listModels(id, key, !!args.force_refresh);
    if (name === 'aixx_chat') return await chat(id, key, args);
    if (name === 'aixx_image') return await image(id, key, args);
    if (name === 'aixx_video') return await video(id, key, args);
    if (name === 'aixx_task') return await task(id, key, args);
    return toolResult(id, `未知工具: ${name}`, true);
  } catch (e) {
    return toolResult(id, `调用 AIXX 失败: ${e.message}`, true);
  }
}

// ---------- API wrappers ----------
async function httpJson(url, opts, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || text || `HTTP ${res.status}`;
      const err = new Error(`[${res.status}] ${msg}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function authHeaders(key, extra) {
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function listModels(id, key, force) {
  if (!force && modelCache && Date.now() - modelCacheAt < MODEL_TTL_MS) {
    return toolResult(id, `(缓存) AIXX 在架文本模型共 ${modelCache.length} 个:\n` + formatModels(modelCache));
  }
  const json = await httpJson(`${BASE_URL}/models`, { headers: authHeaders(key) }, 30000);
  const data = json.data || [];
  modelCache = data; modelCacheAt = Date.now();
  return toolResult(id, `AIXX 在架文本模型共 ${data.length} 个:\n` + formatModels(data));
}

function formatModels(data) {
  const byVendor = {};
  for (const m of data) {
    const v = m.owned_by || 'unknown';
    (byVendor[v] = byVendor[v] || []).push(m.id);
  }
  const lines = [];
  for (const [v, ids] of Object.entries(byVendor)) {
    lines.push(`[${v}] (${ids.length})`);
    for (const x of ids) lines.push(`  - ${x}`);
  }
  return lines.join('\n');
}

async function chat(id, key, args) {
  if (!Array.isArray(args.messages) || !args.messages.length) {
    return toolResult(id, 'messages 不能为空。', true);
  }
  const body = {
    model: args.model || 'claude-haiku-4-5',
    messages: args.messages,
    max_tokens: args.max_tokens || 1024
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;

  const json = await httpJson(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body)
  }, 180000);

  const choice = (json.choices && json.choices[0]) || {};
  const content = (choice.message && choice.message.content) || '';
  const reasoning = (choice.message && choice.message.reasoning_content) || '';
  const usage = json.usage || {};

  let out = '';
  if (content) out += content;
  if (reasoning) out += (out ? '\n\n' : '') + `[思考过程]\n${reasoning}`;
  if (!out) {
    out = '(模型未返回正文内容。如果用的是推理模型如 deepseek-v4-pro,可能 max_tokens 被思考占满,请调大 max_tokens 后重试。)';
  }
  out += `\n\n— 模型: ${json.model || body.model} ｜ tokens: ${usage.total_tokens != null ? usage.total_tokens : 'n/a'}(prompt ${usage.prompt_tokens != null ? usage.prompt_tokens : '?'}/completion ${usage.completion_tokens != null ? usage.completion_tokens : '?'})`;
  return toolResult(id, out, !content && !!reasoning);
}

async function image(id, key, args) {
  const body = {
    user_compute_key: key,
    prompt: args.prompt,
    size: args.size || '1:1'
  };
  if (args.model) body.model = args.model;

  const json = await httpJson(`${BASE_URL}/media/image`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body)
  }, 95000);

  if (json.task_id) {
    return toolResult(id, `出图超过 90s,已转为后台任务。\ntask_id: ${json.task_id}\n请用 aixx_task 轮询结果。`);
  }
  const urls = [];
  if (Array.isArray(json.data)) for (const d of json.data) if (d.url) urls.push(d.url);
  if (json.url) urls.push(json.url);
  if (json.result_url) urls.push(json.result_url);
  if (urls.length) {
    return toolResult(id, `出图完成(${body.model || '自动选模'} / ${body.size}):\n` + urls.join('\n'));
  }
  return toolResult(id, '出图返回:\n' + JSON.stringify(json, null, 2));
}

async function video(id, key, args) {
  const body = {
    user_compute_key: key,
    prompt: args.prompt,
    model: args.model || 'minimax-h3',
    duration: args.duration || 5,
    resolution: args.resolution || '480p'
  };
  const json = await httpJson(`${BASE_URL}/media/video`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body)
  }, 60000);
  const tid = json.task_id || json.id;
  if (!tid) return toolResult(id, '视频提交返回:\n' + JSON.stringify(json, null, 2));
  return toolResult(id, `视频任务已提交(${body.model} / ${body.duration}s / ${body.resolution})。\ntask_id: ${tid}\n状态: ${json.status || 'submitted'}\n用 aixx_task 轮询进度,失败自动退款。限速 5次/分钟/Key。`);
}

async function task(id, key, args) {
  const json = await httpJson(
    `${BASE_URL}/media/task/${encodeURIComponent(args.task_id)}?user_compute_key=${encodeURIComponent(key)}`,
    { headers: authHeaders(key) },
    30000
  );
  const lines = [
    `task_id: ${args.task_id}`,
    `status: ${json.status ?? 'unknown'}`,
  ];
  if (json.progress != null) lines.push(`progress: ${json.progress}`);
  if (json.result_url) lines.push(`result_url: ${json.result_url}`);
  if (json.url) lines.push(`url: ${json.url}`);
  if (json.error) lines.push(`error: ${json.error}`);
  if (!json.result_url && !json.url && !json.error) {
    lines.push('raw: ' + JSON.stringify(json));
  }
  return toolResult(id, lines.join('\n'));
}

// ---------- MCP result helper ----------
function toolResult(id, text, isError) {
  reply(id, {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError
  });
}
