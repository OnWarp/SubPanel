import { Lexer, Parser } from 'yaml'

export function assertYamlBudget(source: string): void {
  const parser = new Parser()
  let count = 0
  for (const lexeme of new Lexer().lex(source)) {
    count++
    if (count > 200_000) throw new Error('YAML token budget exceeded')
    for (const token of parser.next(lexeme)) {
      if (token.type === 'error') throw new Error('Invalid YAML')
    }
    if (parser.stack.length > 40) throw new Error('YAML nesting budget exceeded')
  }
}
