import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'mcp', 'server.mjs');

function session() {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  const inbox = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      try {
        inbox.push(JSON.parse(line));
      } catch {
        /* 忽略非 JSON 输出 */
      }
    }
  });
  let seq = 0;
  return {
    child,
    async call(method, params) {
      const id = ++seq;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const started = Date.now();
      for (;;) {
        const hit = inbox.find((message) => message.id === id);
        if (hit) return hit;
        if (Date.now() - started > 15000) throw new Error(`timeout: ${method}`);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    },
    close() {
      child.stdin.end();
      return new Promise((resolve) => child.on('exit', resolve));
    },
  };
}

test('MCP 资源与提示词', async () => {
  const client = session();
  try {
    const init = await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.ok(init.result.capabilities.resources);
    assert.ok(init.result.capabilities.prompts);

    const resources = await client.call('resources/list', {});
    const uris = resources.result.resources.map((item) => item.uri);
    assert.deepEqual(uris.slice().sort(), [
      'web-scout://config',
      'web-scout://health',
      'web-scout://platforms',
      'web-scout://recent',
      'web-scout://watches',
    ]);

    const templates = await client.call('resources/templates/list', {});
    assert.equal(templates.result.resourceTemplates[0].uriTemplate, 'web-scout://platform/{id}');

    const prompts = await client.call('prompts/list', {});
    assert.deepEqual(prompts.result.prompts.map((item) => item.name).sort(), ['platform_sweep', 'research_topic', 'watch_topic']);

    const prompt = await client.call('prompts/get', { name: 'platform_sweep', arguments: { topic: 'cordis', platforms: 'gitee,csdn' } });
    const text = prompt.result.messages[0].content.text;
    assert.match(text, /gitee,csdn/);
    assert.match(text, /cordis/);

    const bad = await client.call('prompts/get', { name: 'research_topic', arguments: {} });
    assert.ok(bad.error && /缺少 topic/.test(bad.error.message));
  } finally {
    await client.close();
  }
});

test('未知资源返回 -32602', async () => {
  const client = session();
  try {
    await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const bad = await client.call('resources/read', { uri: 'web-scout://missing' });
    assert.equal(bad.error.code, -32602);
    assert.match(bad.error.message, /不支持的资源/);
  } finally {
    await client.close();
  }
});