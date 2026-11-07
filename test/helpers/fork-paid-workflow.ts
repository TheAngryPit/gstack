/** Compare upstream routing beneath the independently asserted official-repository gate. */
export function upstreamCondition(value: string | undefined): string | undefined {
  if (value === undefined) return value;
  let expression = value.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const gate = "github.repository == 'garrytan/gstack'";
  if (expression === gate) return 'true';
  if (!expression.startsWith(`${gate} && `)) return expression;
  expression = expression.slice(gate.length + 4);
  if (expression.startsWith('(') && expression.endsWith(')')) expression = expression.slice(1, -1);
  return expression;
}
