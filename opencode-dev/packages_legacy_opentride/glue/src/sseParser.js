// Minimal SSE parser for fetch() ReadableStream.
// Produces { event, id, data } where data is a string.

export async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  let buf = '';
  let event = undefined;
  let id = undefined;
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0 && event == null && id == null) return null;
    const data = dataLines.join('\n');
    const msg = { event, id, data };
    event = undefined;
    id = undefined;
    dataLines = [];
    return msg;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          const m = flush();
          if (m) yield m;
          continue;
        }
        if (line.startsWith(':')) continue;

        const sep = line.indexOf(':');
        const field = sep === -1 ? line : line.slice(0, sep);
        let valueStr = sep === -1 ? '' : line.slice(sep + 1);
        if (valueStr.startsWith(' ')) valueStr = valueStr.slice(1);

        if (field === 'event') event = valueStr;
        else if (field === 'id') id = valueStr;
        else if (field === 'data') dataLines.push(valueStr);
      }
    }

    const tail = flush();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
