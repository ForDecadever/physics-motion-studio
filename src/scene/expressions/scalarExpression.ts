const MAX_EXPRESSION_LENGTH = 256
const MAX_AST_NODES = 128
const MAX_PARSE_DEPTH = 32
const MAX_EXPONENT = 8

const FUNCTION_NAMES = new Set(['abs', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max'])
const CONSTANT_VALUES: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E }

export const scalarExpressionReservedNames = new Set([
  't',
  ...FUNCTION_NAMES,
  ...Object.keys(CONSTANT_VALUES),
])

export interface ScalarExpressionContext {
  time: number
  variables: Readonly<Record<string, number>>
}

export interface CompiledScalarExpression {
  source: string
  referencedVariables: readonly string[]
  usesTime: boolean
  evaluate: (context: ScalarExpressionContext) => number | null
}

export interface ScalarExpressionCompileOptions {
  allowTime?: boolean
  variableNames?: ReadonlySet<string>
}

export class ScalarExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScalarExpressionError'
  }
}

type TokenKind = 'number' | 'identifier' | 'operator' | 'left' | 'right' | 'comma' | 'end'

interface Token {
  kind: TokenKind
  text: string
  number?: number
  position: number
}

type AstNode =
  | { type: 'number'; value: number; constantValue: number }
  | { type: 'time'; constantValue: undefined }
  | { type: 'variable'; name: string; constantValue: undefined }
  | { type: 'unary'; operator: '+' | '-'; operand: AstNode; constantValue: number | undefined }
  | {
      type: 'binary'
      operator: '+' | '-' | '*' | '/' | '^'
      left: AstNode
      right: AstNode
      constantValue: number | undefined
    }
  | { type: 'function'; name: string; args: AstNode[]; constantValue: number | undefined }

function rawTokens(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]!
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (/[0-9.]/.test(character)) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)
      if (!match) throw new ScalarExpressionError(`位置 ${index + 1} 的数字格式无效。`)
      const value = Number(match[0])
      if (!Number.isFinite(value)) throw new ScalarExpressionError('表达式中的数字必须是有限值。')
      tokens.push({ kind: 'number', text: match[0], number: value, position: index })
      index += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)
      if (!match) throw new ScalarExpressionError(`位置 ${index + 1} 的名称无效。`)
      tokens.push({ kind: 'identifier', text: match[0], position: index })
      index += match[0].length
      continue
    }
    if ('+-*/^'.includes(character)) {
      tokens.push({ kind: 'operator', text: character, position: index })
    } else if (character === '(') {
      tokens.push({ kind: 'left', text: character, position: index })
    } else if (character === ')') {
      tokens.push({ kind: 'right', text: character, position: index })
    } else if (character === ',') {
      tokens.push({ kind: 'comma', text: character, position: index })
    } else {
      throw new ScalarExpressionError(`位置 ${index + 1} 包含不支持的字符“${character}”。`)
    }
    index += 1
  }
  return tokens
}

function tokenize(source: string): Token[] {
  const sourceTokens = rawTokens(source)
  const tokens: Token[] = []
  for (const token of sourceTokens) {
    const previous = tokens.at(-1)
    const previousCanMultiply =
      previous?.kind === 'number' || previous?.kind === 'identifier' || previous?.kind === 'right'
    const currentCanMultiply =
      token.kind === 'number' || token.kind === 'identifier' || token.kind === 'left'
    const isFunctionCall =
      previous?.kind === 'identifier' && token.kind === 'left' && FUNCTION_NAMES.has(previous.text)
    if (previousCanMultiply && currentCanMultiply && !isFunctionCall) {
      tokens.push({ kind: 'operator', text: '*', position: token.position })
    }
    tokens.push(token)
  }
  tokens.push({ kind: 'end', text: '', position: source.length })
  return tokens
}

class Parser {
  private index = 0
  private nodeCount = 0

  constructor(
    private readonly tokens: Token[],
    private readonly options: Required<ScalarExpressionCompileOptions>,
  ) {}

  parse(): AstNode {
    const node = this.parseExpression(0, 0)
    const remaining = this.peek()
    if (remaining.kind !== 'end') {
      throw new ScalarExpressionError(`位置 ${remaining.position + 1} 附近存在多余内容。`)
    }
    return node
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens.at(-1)!
  }

  private consume(): Token {
    const token = this.peek()
    this.index += 1
    return token
  }

  private countNode<T extends AstNode>(node: T): T {
    this.nodeCount += 1
    if (this.nodeCount > MAX_AST_NODES) {
      throw new ScalarExpressionError(`表达式最多包含 ${MAX_AST_NODES} 个运算节点。`)
    }
    return node
  }

  private parseExpression(minimumPrecedence: number, depth: number): AstNode {
    if (depth > MAX_PARSE_DEPTH) throw new ScalarExpressionError('表达式括号或运算嵌套过深。')
    let left = this.parsePrefix(depth + 1)
    while (true) {
      const token = this.peek()
      if (token.kind !== 'operator') break
      const precedence =
        token.text === '+' || token.text === '-'
          ? 1
          : token.text === '*' || token.text === '/'
            ? 2
            : 3
      if (precedence < minimumPrecedence) break
      this.consume()
      const right = this.parseExpression(precedence + (token.text === '^' ? 0 : 1), depth + 1)
      left = this.createBinary(token.text as '+' | '-' | '*' | '/' | '^', left, right)
    }
    return left
  }

  private parsePrefix(depth: number): AstNode {
    const token = this.consume()
    if (token.kind === 'number') {
      return this.countNode({ type: 'number', value: token.number!, constantValue: token.number! })
    }
    if (token.kind === 'operator' && (token.text === '+' || token.text === '-')) {
      const operand = this.parseExpression(4, depth + 1)
      return this.countNode({
        type: 'unary',
        operator: token.text,
        operand,
        constantValue:
          operand.constantValue === undefined
            ? undefined
            : token.text === '-'
              ? -operand.constantValue
              : operand.constantValue,
      })
    }
    if (token.kind === 'left') {
      const expression = this.parseExpression(0, depth + 1)
      if (this.consume().kind !== 'right') throw new ScalarExpressionError('表达式中缺少右括号。')
      return expression
    }
    if (token.kind === 'identifier') {
      if (this.peek().kind === 'left' && FUNCTION_NAMES.has(token.text)) {
        return this.parseFunction(token.text, depth + 1)
      }
      if (token.text === 't') {
        if (!this.options.allowTime)
          throw new ScalarExpressionError('这个属性不允许使用时间变量 t。')
        return this.countNode({ type: 'time', constantValue: undefined })
      }
      const constant = CONSTANT_VALUES[token.text]
      if (constant !== undefined) {
        return this.countNode({ type: 'number', value: constant, constantValue: constant })
      }
      if (!this.options.variableNames.has(token.text)) {
        throw new ScalarExpressionError(`未知全局变量“${token.text}”。`)
      }
      return this.countNode({ type: 'variable', name: token.text, constantValue: undefined })
    }
    throw new ScalarExpressionError(`位置 ${token.position + 1} 需要数字、变量或左括号。`)
  }

  private parseFunction(name: string, depth: number): AstNode {
    this.consume()
    const args: AstNode[] = []
    if (this.peek().kind !== 'right') {
      while (true) {
        args.push(this.parseExpression(0, depth + 1))
        if (this.peek().kind !== 'comma') break
        this.consume()
      }
    }
    if (this.consume().kind !== 'right')
      throw new ScalarExpressionError(`函数 ${name} 缺少右括号。`)
    if ((name === 'min' || name === 'max') && args.length < 2) {
      throw new ScalarExpressionError(`${name} 至少需要两个参数。`)
    }
    if (name !== 'min' && name !== 'max' && args.length !== 1) {
      throw new ScalarExpressionError(`${name} 只接受一个参数。`)
    }
    const values = args.map((argument) => argument.constantValue)
    const constantValue = values.every((value) => value !== undefined)
      ? evaluateFunction(name, values as number[])
      : undefined
    return this.countNode({ type: 'function', name, args, constantValue })
  }

  private createBinary(
    operator: '+' | '-' | '*' | '/' | '^',
    left: AstNode,
    right: AstNode,
  ): AstNode {
    if (operator === '^') {
      if (right.constantValue === undefined) {
        throw new ScalarExpressionError('乘方的指数必须是常数。')
      }
      if (Math.abs(right.constantValue) > MAX_EXPONENT) {
        throw new ScalarExpressionError(`乘方指数必须在 -${MAX_EXPONENT} 到 ${MAX_EXPONENT} 之间。`)
      }
    }
    let constantValue: number | undefined
    if (left.constantValue !== undefined && right.constantValue !== undefined) {
      const candidate = evaluateBinary(operator, left.constantValue, right.constantValue)
      if (Number.isFinite(candidate)) constantValue = candidate
    }
    return this.countNode({ type: 'binary', operator, left, right, constantValue })
  }
}

function evaluateBinary(
  operator: '+' | '-' | '*' | '/' | '^',
  left: number,
  right: number,
): number {
  if (operator === '+') return left + right
  if (operator === '-') return left - right
  if (operator === '*') return left * right
  if (operator === '/') return left / right
  return left ** right
}

function evaluateFunction(name: string, args: number[]): number {
  if (name === 'abs') return Math.abs(args[0]!)
  if (name === 'sqrt') return Math.sqrt(args[0]!)
  if (name === 'sin') return Math.sin(args[0]!)
  if (name === 'cos') return Math.cos(args[0]!)
  if (name === 'tan') return Math.tan(args[0]!)
  if (name === 'min') return Math.min(...args)
  return Math.max(...args)
}

function evaluateNode(node: AstNode, context: ScalarExpressionContext): number | null {
  if (node.type === 'number') return node.value
  if (node.type === 'time') return Number.isFinite(context.time) ? context.time : null
  if (node.type === 'variable') {
    const value = context.variables[node.name]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  if (node.type === 'unary') {
    const value = evaluateNode(node.operand, context)
    return value === null ? null : node.operator === '-' ? -value : value
  }
  if (node.type === 'binary') {
    const left = evaluateNode(node.left, context)
    const right = evaluateNode(node.right, context)
    if (left === null || right === null || (node.operator === '/' && right === 0)) return null
    const value = evaluateBinary(node.operator, left, right)
    return Number.isFinite(value) ? value : null
  }
  const values = node.args.map((argument) => evaluateNode(argument, context))
  if (values.some((value) => value === null)) return null
  const value = evaluateFunction(node.name, values as number[])
  return Number.isFinite(value) ? value : null
}

function collectMetadata(node: AstNode, variables: Set<string>): boolean {
  if (node.type === 'time') return true
  if (node.type === 'variable') {
    variables.add(node.name)
    return false
  }
  if (node.type === 'number') return false
  const children =
    node.type === 'unary'
      ? [node.operand]
      : node.type === 'binary'
        ? [node.left, node.right]
        : node.args
  return children.some((child) => collectMetadata(child, variables))
}

export function compileScalarExpression(
  source: string,
  options: ScalarExpressionCompileOptions = {},
): CompiledScalarExpression {
  const normalized = source.trim()
  if (!normalized) throw new ScalarExpressionError('表达式不能为空。')
  if (normalized.length > MAX_EXPRESSION_LENGTH) {
    throw new ScalarExpressionError(`表达式最多包含 ${MAX_EXPRESSION_LENGTH} 个字符。`)
  }
  const resolvedOptions: Required<ScalarExpressionCompileOptions> = {
    allowTime: options.allowTime ?? false,
    variableNames: options.variableNames ?? new Set<string>(),
  }
  const ast = new Parser(tokenize(normalized), resolvedOptions).parse()
  const variables = new Set<string>()
  const usesTime = collectMetadata(ast, variables)
  return {
    source: normalized,
    referencedVariables: [...variables].sort(),
    usesTime,
    evaluate: (context) => evaluateNode(ast, context),
  }
}
