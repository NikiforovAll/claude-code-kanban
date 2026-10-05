function oneLine(text, max) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters on purpose
  return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

module.exports = { oneLine };
