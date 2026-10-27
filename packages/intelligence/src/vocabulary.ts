// Word lists for the requirement checker (checker.ts). Edit here, not in the checker.

// Words that say nothing a test can check.
export const VAGUE = [
  "correct", "correctly", "properly", "proper", "right", "accurate", "accurately", "fast", "quickly", "quick",
  "slow", "intuitive", "user-friendly", "user friendly", "easy", "simple", "nice", "good", "better", "appropriate",
  "appropriately", "reasonable", "acceptable", "adequate", "sufficient", "seamless", "seamlessly", "smooth",
  "robust", "efficient", "clean", "normal", "should work", "works", "as expected", "expected", "etc", "and so on",
];

// Words that name something on screen or in an API response.
export const UI_NOUNS = [
  "page", "screen", "column", "field", "table", "row", "cell", "button", "link", "label", "message", "error message",
  "tooltip", "dialog", "modal", "form", "tab", "header", "banner", "toast", "chart", "api", "endpoint", "response",
];

// Values, units, formulas, order and edge cases.
export const CONCRETE = [
  "unit", "units", "count", "percent", "percentage", "currency", "monetary", "decimal", "decimals", "integer",
  "whole number", "whole numbers", "date", "format", "days", "hours", "minutes", "sum", "total of", "equal",
  "equals", "average", "minus", "plus", "divided", "multiplied", "ratio", "formula", "rounded", "sorted",
  "ascending", "descending", "alphabetical", "before", "after", "first", "last", "empty", "zero", "negative",
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "blank", "null", "missing", "maximum", "minimum", "at least", "at most", "greater than", "less than",
  "more than", "fewer than", "rejected", "error", "only", "required", "disabled", "hidden",
];

// After " and ", one of these starts a second rule ("... and sees a confirmation").
export const CLAUSE_STARTS = [
  "must", "should", "shall", "can", "cannot", "will", "may", "is", "are", "was", "becomes", "shows", "displays",
  "sees", "returns", "sends", "gets", "has", "have", "opens", "redirects", "also", "then",
];

// Out of scope for a browser-driven check of one signed-in user; each match makes a draft Not testable here.
export const OUT_OF_SCOPE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(performance|latency|load time|loads? (in|within)|response time|within \d+ ?(ms|milliseconds|seconds?|s)\b)/i, reason: "Performance needs timing infrastructure, not a functional browser check." },
  { pattern: /\b(load test|under load|stress|throughput|requests per second|\d+ (concurrent )?users)\b/i, reason: "Load testing needs many simultaneous clients." },
  { pattern: /\b(security|secure|penetration|vulnerab\w*|xss|sql injection|csrf|encrypt\w*|hash(ed)?)\b/i, reason: "Security testing is out of scope." },
  { pattern: /\b(e-?mails? (is |are )?(sent|delivered|received)|(sends?|receives?|deliver\w*) (an |the )?e-?mail|inbox|notification e-?mail)\b/i, reason: "Email delivery cannot be observed in the browser." },
  { pattern: /\b(database|stored in|persisted|cron|batch job|background job|server log|log file|backend)\b/i, reason: "Backend-only behavior cannot be observed in the browser." },
  { pattern: /\b(multiple users|two users|another user|other users|concurrent\w*|simultaneous\w*|at the same time)\b/i, reason: "Multi-user behavior needs several sessions; runs use one user." },
];

// Ignored when comparing requirements for near-duplicates.
export const STOPWORDS = ["the", "a", "an", "of", "to", "is", "are", "be", "must", "should", "shall", "and", "or", "in", "on", "for", "with", "each", "all", "it", "that", "this"];
