/**
 * OSC 8 terminal hyperlink: makes `text` a clickable link to `url` in supporting terminals
 * (incl. VS Code's integrated terminal). Framing: ESC ] 8 ; ; URL ST  text  ESC ] 8 ; ; ST.
 * This is part of the Claude Code status-line *interface*, not anyone's source (PLAN §0).
 */
const OSC = "\x1b]8;;";
const ST = "\x1b\\";

export function osc8Link(url: string, text: string): string {
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}
