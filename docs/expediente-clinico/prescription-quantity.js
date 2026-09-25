(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MacroxelPrescriptionQuantity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COUNT_UNITS = [
    "TABLETAS?", "TABS?", "CAPSULAS?", "CAPS?", "PIEZAS?", "PZS?", "SOBRES?", "AMPOLLAS?", "AMPS?",
    "VIALES?", "OVULOS?", "SUPOSITORIOS?", "COMPRIMIDOS?", "GRAGEAS?", "PASTILLAS?", "GOMITAS?", "DOSIS"
  ].join("|");
  const COUNT_RE = new RegExp(`\\b(\\d{1,4}(?:[.,]\\d+)?)\\s*(${COUNT_UNITS})\\b`, "gi");
  const VOLUME_RE = /\b(\d{1,4}(?:[.,]\d+)?)\s*(ML)\b/gi;
  const PACK_RE = /\b(?:CAJA|FRASCO|ENVASE|BLISTER|C)\s*(?:CON|C\s*\/|\/)?\s*(\d{1,4})\b/gi;

  function normalized(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  }

  function positiveInteger(value) {
    const number = Math.trunc(Number(String(value || "").replace(",", ".")));
    return Number.isInteger(number) && number > 0 && number <= 999 ? number : 0;
  }

  function collectText(input) {
    if (typeof input === "string") return normalized(input);
    const source = input && typeof input === "object" ? input : {};
    return normalized([
      source.genericName, source.brandName, source.presentation, source.pharmaceuticalForm,
      source.generica, source.distintiva, source.presentacion, source.nombre
    ].filter(Boolean).join(" "));
  }

  function lastValidMatch(text, regex, { rejectFraction = false } = {}) {
    regex.lastIndex = 0;
    let selected = null;
    let match;
    while ((match = regex.exec(text))) {
      if (rejectFraction && text.slice(Math.max(0, match.index - 2), match.index).includes("/")) continue;
      const quantity = positiveInteger(match[1]);
      if (quantity) selected = { quantity, unit: normalized(match[2] || "PZS"), raw: match[0] };
    }
    return selected;
  }

  function infer(input, fallback = 1) {
    const sourceText = collectText(input);
    const count = lastValidMatch(sourceText, COUNT_RE);
    if (count) return { ...count, source: "COUNT", sourceText };

    const pack = lastValidMatch(sourceText, PACK_RE);
    if (pack) return { ...pack, unit: "PZS", source: "PACK", sourceText };

    // En líquidos se toma el último volumen declarado para no confundir una
    // concentración como 250 MG/5 ML con la presentación final de 60 ML.
    const volume = lastValidMatch(sourceText, VOLUME_RE, { rejectFraction: true });
    if (volume) return { ...volume, source: "VOLUME", sourceText };

    return { quantity: positiveInteger(fallback) || 1, unit: "PZS", raw: "", source: "DEFAULT", sourceText };
  }

  function effective(input, fallback = 1) {
    const captured = positiveInteger(input?.quantityToDispense);
    return captured || infer(input, fallback).quantity;
  }

  return Object.freeze({ infer, effective, positiveInteger });
});
