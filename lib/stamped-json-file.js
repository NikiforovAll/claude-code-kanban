const path = require('node:path');
const { readFileSync, statSync } = require('node:fs');
const { httpError } = require('./http-error');

// A JSON file that the board keeps in memory and other boards on the same config dir also write.
// `load` answers undefined while the file's mtime and size are the ones last read or written, and
// null when there is no file. A file that cannot be read or parsed (a hand edit, a cut-off write,
// EBUSY while another board renames over it) also answers undefined, so memory keeps the last good
// state, and the next load tries again. While it cannot be read, `save` refuses with a 503, because
// the write would replace the user's file. A failed write is a 503 too.
function stampedJsonFile(file, writeJsonAtomic) {
  const name = path.basename(file);
  const stampOf = () => {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  };
  let stamp;
  let readError = null;
  return {
    load: () => {
      const next = stampOf();
      if (next === stamp && !readError) return undefined;
      try {
        const data = next === null ? null : JSON.parse(readFileSync(file, 'utf8'));
        readError = null;
        stamp = next;
        return data;
      } catch (e) {
        readError = e;
        return undefined;
      }
    },
    save: (data) => {
      if (readError) throw httpError(503, `${name} cannot be read (${readError.code || readError.message}); fix or delete it`);
      try {
        writeJsonAtomic(file, data);
      } catch (e) {
        throw httpError(503, `${name} not saved (${e.code || e.message})`);
      }
      stamp = stampOf();
    },
  };
}

module.exports = { stampedJsonFile };
