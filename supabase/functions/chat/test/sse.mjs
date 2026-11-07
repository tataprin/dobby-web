// Builders for scripted Anthropic streaming responses (the raw SSE events of POST /v1/messages).
let n = 0;

/** One whole streamed message. blocks: {text} | {thinking: '', signature} | {tool: name, id?, input | json} | {fallback: {from, to}} */
export function message(blocks, { stop_reason = 'end_turn', model = 'claude-opus-5-5', usage = {}, stop_details = null } = {}) {
  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage };
  const ev = [{
    type: 'message_start',
    message: {
      id: `msg_fake_${++n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: u.input_tokens, output_tokens: 1, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens },
    },
  }];
  blocks.forEach((b, index) => {
    if (b.text !== undefined) {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of chunks(b.text, 12)) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    } else if (b.thinking !== undefined) {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (b.thinking) ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature || 'sig_fake' } });
    } else if (b.tool) {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id || `toolu_${++n}`, name: b.tool, input: {} } });
      const json = b.json !== undefined ? b.json : JSON.stringify(b.input ?? {});
      for (const part of chunks(json, 9)) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    } else if (b.fallback) {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: b.fallback.from }, to: { model: b.fallback.to } } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details }, usage: { output_tokens: u.output_tokens, ...(u.iterations ? { iterations: u.iterations } : {}) } });
  ev.push({ type: 'message_stop' });
  return { sse: ev };
}

/** A stream that fails part-way with an SSE `error` event (e.g. overloaded_error). */
export function streamError(type = 'overloaded_error', text = 'partial ') {
  const m = message([{ text }]).sse;
  return { sse: [...m.slice(0, 3), { type: 'error', error: { type, message: 'Overloaded' } }] };
}

function chunks(s, size) {
  const out = [];
  const a = Array.from(s);
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size).join(''));
  return out.length ? out : [''];
}
