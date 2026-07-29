import type { RuntimeBodyState } from '../../physics/worker/messages'

const MAX_EXPRESSION_LENGTH = 256
const MAX_AST_NODES = 128
const MAX_PARSE_DEPTH = 32
const DIMENSION_EPSILON = 1e-9

type Dimension = readonly [
  mass: number,
  length: number,
  time: number,
  angle: number,
  charge: number,
]

const DIMENSIONLESS: Dimension = [0, 0, 0, 0, 0]
const MASS: Dimension = [1, 0, 0, 0, 0]
const LENGTH: Dimension = [0, 1, 0, 0, 0]
const TIME: Dimension = [0, 0, 1, 0, 0]
const ANGLE: Dimension = [0, 0, 0, 1, 0]
const CHARGE: Dimension = [0, 0, 0, 0, 1]
const VELOCITY: Dimension = [0, 1, -1, 0, 0]
const ACCELERATION: Dimension = [0, 1, -2, 0, 0]
const ANGULAR_VELOCITY: Dimension = [0, 0, -1, 1, 0]
const FORCE: Dimension = [1, 1, -2, 0, 0]
const ENERGY: Dimension = [1, 2, -2, 0, 0]

export interface ChartExpressionContext {
  time: number
  self: RuntimeBodyState | undefined
  bindings: Readonly<Record<string, RuntimeBodyState | undefined>>
}

export interface CompiledChartExpression {
  source: string
  unit: string
  referencedAliases: readonly string[]
  usesSelf: boolean
  evaluate: (context: ChartExpressionContext) => number | null
}

export class ChartExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChartExpressionError'
  }
}

interface ValueDefinition {
  dimension: Dimension
  read: (body: RuntimeBodyState) => number
}

const valueDefinitions: Readonly<Record<string, ValueDefinition>> = {
  x: { dimension: LENGTH, read: (body) => body.position.x },
  y: { dimension: LENGTH, read: (body) => body.position.y },
  vx: { dimension: VELOCITY, read: (body) => body.linearVelocity.x },
  vy: { dimension: VELOCITY, read: (body) => body.linearVelocity.y },
  speed: {
    dimension: VELOCITY,
    read: (body) => Math.hypot(body.linearVelocity.x, body.linearVelocity.y),
  },
  ax: { dimension: ACCELERATION, read: (body) => body.acceleration.x },
  ay: { dimension: ACCELERATION, read: (body) => body.acceleration.y },
  acc: {
    dimension: ACCELERATION,
    read: (body) => Math.hypot(body.acceleration.x, body.acceleration.y),
  },
  angle: { dimension: ANGLE, read: (body) => body.angleRad },
  omega: { dimension: ANGULAR_VELOCITY, read: (body) => body.angularVelocityRad },
  Fx: { dimension: FORCE, read: (body) => body.netForce.x },
  Fy: { dimension: FORCE, read: (body) => body.netForce.y },
  force: {
    dimension: FORCE,
    read: (body) => Math.hypot(body.netForce.x, body.netForce.y),
  },
  Ek: { dimension: ENERGY, read: (body) => body.kineticEnergyJ },
  Etrans: { dimension: ENERGY, read: (body) => body.translationalKineticEnergyJ },
  Erot: { dimension: ENERGY, read: (body) => body.rotationalKineticEnergyJ },
}

export const chartExpressionVariables = [
  't',
  'x',
  'y',
  'vx',
  'vy',
  'speed',
  'ax',
  'ay',
  'acc',
  'angle',
  'omega',
  'Fx',
  'Fy',
  'force',
  'Ek',
  'Etrans',
  'Erot',
] as const

const unitDefinitions: Readonly<Record<string, Dimension>> = {
  m: LENGTH,
  s: TIME,
  kg: MASS,
  rad: ANGLE,
  N: FORCE,
  J: ENERGY,
  C: CHARGE,
}

type TokenKind =
  'number' | 'identifier' | 'reference' | 'operator' | 'left' | 'right' | 'comma' | 'end'

interface Token {
  kind: TokenKind
  text: string
  number?: number
  alias?: string | undefined
  member?: string | undefined
  position: number
}

interface AstBase {
  dimension: Dimension
  constantValue: number | undefined
}

type AstNode = AstBase &
  (
    | { type: 'number'; value: number }
    | {
        type: 'value'
        read: (context: ChartExpressionContext) => number | null
        usesSelf: boolean
        alias?: string | undefined
      }
    | {
        type: 'unary'
        operator: '+' | '-'
        operand: AstNode
      }
    | {
        type: 'binary'
        operator: '+' | '-' | '*' | '/' | '^'
        left: AstNode
        right: AstNode
      }
    | {
        type: 'function'
        name: string
        args: AstNode[]
      }
  )

function dimensionsEqual(first: Dimension, second: Dimension): boolean {
  return first.every((value, index) => Math.abs(value - second[index]!) <= DIMENSION_EPSILON)
}

function addDimensions(first: Dimension, second: Dimension, multiplier = 1): Dimension {
  return first.map((value, index) => value + second[index]! * multiplier) as unknown as Dimension
}

function scaleDimension(dimension: Dimension, exponent: number): Dimension {
  return dimension.map((value) => value * exponent) as unknown as Dimension
}

function superscript(value: number): string {
  const rounded = Math.round(value)
  const source =
    Math.abs(value - rounded) <= DIMENSION_EPSILON
      ? String(rounded)
      : Number(value.toFixed(3)).toString()
  const map: Record<string, string> = {
    '-': '⁻',
    '.': '·',
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
  }
  return [...source].map((character) => map[character] ?? character).join('')
}

export function formatChartDimension(dimension: Dimension): string {
  const common: Array<[Dimension, string]> = [
    [DIMENSIONLESS, '1'],
    [LENGTH, 'm'],
    [TIME, 's'],
    [MASS, 'kg'],
    [ANGLE, 'rad'],
    [CHARGE, 'C'],
    [VELOCITY, 'm/s'],
    [ACCELERATION, 'm/s²'],
    [ANGULAR_VELOCITY, 'rad/s'],
    [FORCE, 'N'],
    [ENERGY, 'J'],
  ]
  const known = common.find(([candidate]) => dimensionsEqual(candidate, dimension))
  if (known) return known[1]

  const symbols = ['kg', 'm', 's', 'rad', 'C']
  const numerator: string[] = []
  const denominator: string[] = []
  dimension.forEach((exponent, index) => {
    if (Math.abs(exponent) <= DIMENSION_EPSILON) return
    const target = exponent > 0 ? numerator : denominator
    const magnitude = Math.abs(exponent)
    target.push(
      `${symbols[index]!}${Math.abs(magnitude - 1) <= DIMENSION_EPSILON ? '' : superscript(magnitude)}`,
    )
  })
  const top = numerator.length > 0 ? numerator.join('·') : '1'
  return denominator.length > 0 ? `${top}/${denominator.join('·')}` : top
}

function tokenize(source: string): Token[] {
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
      if (!match) throw new ChartExpressionError(`位置 ${index + 1} 的数字格式无效。`)
      const value = Number(match[0])
      if (!Number.isFinite(value)) throw new ChartExpressionError('公式中的数字必须是有限值。')
      tokens.push({ kind: 'number', text: match[0], number: value, position: index })
      index += match[0].length
      continue
    }
    if (character === '@') {
      const match = source.slice(index).match(/^@([A-Z])\.([A-Za-z][A-Za-z0-9]*)/)
      if (!match) {
        throw new ChartExpressionError(`位置 ${index + 1} 的物体引用应写成 @A.x。`)
      }
      tokens.push({
        kind: 'reference',
        text: match[0],
        alias: match[1]!,
        member: match[2]!,
        position: index,
      })
      index += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)
      if (!match) throw new ChartExpressionError(`位置 ${index + 1} 的名称无效。`)
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
      throw new ChartExpressionError(`位置 ${index + 1} 包含不支持的字符“${character}”。`)
    }
    index += 1
  }
  tokens.push({ kind: 'end', text: '', position: source.length })
  return tokens
}

class Parser {
  private index = 0
  private nodeCount = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const node = this.parseExpression(0, 0)
    const remaining = this.peek()
    if (remaining.kind !== 'end') {
      throw new ChartExpressionError(`位置 ${remaining.position + 1} 附近存在多余内容。`)
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
      throw new ChartExpressionError(`公式最多包含 ${MAX_AST_NODES} 个运算节点。`)
    }
    return node
  }

  private parseExpression(minimumPrecedence: number, depth: number): AstNode {
    if (depth > MAX_PARSE_DEPTH) throw new ChartExpressionError('公式括号或运算嵌套过深。')
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
      const rightAssociative = token.text === '^'
      const right = this.parseExpression(precedence + (rightAssociative ? 0 : 1), depth + 1)
      left = this.createBinary(token.text as '+' | '-' | '*' | '/' | '^', left, right)
    }
    return left
  }

  private parsePrefix(depth: number): AstNode {
    const token = this.consume()
    if (token.kind === 'number') {
      return this.countNode({
        type: 'number',
        value: token.number!,
        dimension: DIMENSIONLESS,
        constantValue: token.number!,
      })
    }
    if (token.kind === 'operator' && (token.text === '+' || token.text === '-')) {
      const operand = this.parseExpression(4, depth + 1)
      return this.countNode({
        type: 'unary',
        operator: token.text,
        operand,
        dimension: operand.dimension,
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
      const closing = this.consume()
      if (closing.kind !== 'right') throw new ChartExpressionError('公式中缺少右括号。')
      return expression
    }
    if (token.kind === 'reference') {
      const definition = valueDefinitions[token.member!]
      if (!definition) throw new ChartExpressionError(`未知物理量“${token.member}”。`)
      return this.countNode({
        type: 'value',
        dimension: definition.dimension,
        constantValue: undefined,
        alias: token.alias,
        usesSelf: false,
        read: (context) => {
          const body = context.bindings[token.alias!]
          return body ? definition.read(body) : null
        },
      })
    }
    if (token.kind === 'identifier') {
      if (this.peek().kind === 'left') return this.parseFunction(token.text, depth + 1)
      if (token.text === 't') {
        return this.countNode({
          type: 'value',
          dimension: TIME,
          constantValue: undefined,
          usesSelf: false,
          read: (context) => context.time,
        })
      }
      const unit = unitDefinitions[token.text]
      if (unit) {
        return this.countNode({
          type: 'number',
          value: 1,
          dimension: unit,
          constantValue: undefined,
        })
      }
      const definition = valueDefinitions[token.text]
      if (!definition) throw new ChartExpressionError(`未知变量或函数“${token.text}”。`)
      return this.countNode({
        type: 'value',
        dimension: definition.dimension,
        constantValue: undefined,
        usesSelf: true,
        read: (context) => (context.self ? definition.read(context.self) : null),
      })
    }
    throw new ChartExpressionError(`位置 ${token.position + 1} 需要数字、变量或左括号。`)
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
    if (this.consume().kind !== 'right') throw new ChartExpressionError(`函数 ${name} 缺少右括号。`)
    if (!['abs', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max'].includes(name)) {
      throw new ChartExpressionError(`不支持函数“${name}”。`)
    }
    if ((name === 'min' || name === 'max') && args.length < 2) {
      throw new ChartExpressionError(`${name} 至少需要两个参数。`)
    }
    if (name !== 'min' && name !== 'max' && args.length !== 1) {
      throw new ChartExpressionError(`${name} 只接受一个参数。`)
    }
    let dimension = args[0]?.dimension ?? DIMENSIONLESS
    if (name === 'min' || name === 'max') {
      if (args.some((argument) => !dimensionsEqual(argument.dimension, dimension))) {
        throw new ChartExpressionError(`${name} 的所有参数必须具有相同单位。`)
      }
    } else if (name === 'sqrt') {
      dimension = scaleDimension(dimension, 0.5)
    } else if (name === 'sin' || name === 'cos' || name === 'tan') {
      if (!dimensionsEqual(dimension, DIMENSIONLESS) && !dimensionsEqual(dimension, ANGLE)) {
        throw new ChartExpressionError(`${name} 的参数必须无量纲或使用弧度。`)
      }
      dimension = DIMENSIONLESS
    }
    const constantArgs = args.map((argument) => argument.constantValue)
    const constantValue = constantArgs.every((value) => value !== undefined)
      ? evaluateFunction(name, constantArgs as number[])
      : undefined
    return this.countNode({ type: 'function', name, args, dimension, constantValue })
  }

  private createBinary(
    operator: '+' | '-' | '*' | '/' | '^',
    left: AstNode,
    right: AstNode,
  ): AstNode {
    let dimension: Dimension
    if (operator === '+' || operator === '-') {
      if (!dimensionsEqual(left.dimension, right.dimension)) {
        throw new ChartExpressionError(
          `无法${operator === '+' ? '相加' : '相减'}：${formatChartDimension(left.dimension)} 与 ${formatChartDimension(right.dimension)} 的单位不同。`,
        )
      }
      dimension = left.dimension
    } else if (operator === '*') {
      dimension = addDimensions(left.dimension, right.dimension)
    } else if (operator === '/') {
      dimension = addDimensions(left.dimension, right.dimension, -1)
    } else {
      if (!dimensionsEqual(right.dimension, DIMENSIONLESS) || right.constantValue === undefined) {
        throw new ChartExpressionError('乘方的指数必须是无量纲常数。')
      }
      if (Math.abs(right.constantValue) > 8) {
        throw new ChartExpressionError('乘方指数必须在 -8 到 8 之间。')
      }
      dimension = scaleDimension(left.dimension, right.constantValue)
    }

    let constantValue: number | undefined
    if (left.constantValue !== undefined && right.constantValue !== undefined) {
      constantValue = evaluateBinary(operator, left.constantValue, right.constantValue)
      if (!Number.isFinite(constantValue)) constantValue = undefined
    }
    return this.countNode({ type: 'binary', operator, left, right, dimension, constantValue })
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

function evaluateNode(node: AstNode, context: ChartExpressionContext): number | null {
  if (node.type === 'number') return node.value
  if (node.type === 'value') return node.read(context)
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
  const args = node.args.map((argument) => evaluateNode(argument, context))
  if (args.some((value) => value === null)) return null
  const value = evaluateFunction(node.name, args as number[])
  return Number.isFinite(value) ? value : null
}

function collectExpressionMetadata(node: AstNode): {
  aliases: Set<string>
  usesSelf: boolean
} {
  if (node.type === 'value') {
    return {
      aliases: new Set(node.alias ? [node.alias] : []),
      usesSelf: node.usesSelf,
    }
  }
  if (node.type === 'number') return { aliases: new Set(), usesSelf: false }
  const children =
    node.type === 'unary'
      ? [node.operand]
      : node.type === 'binary'
        ? [node.left, node.right]
        : node.args
  const result = { aliases: new Set<string>(), usesSelf: false }
  for (const child of children) {
    const metadata = collectExpressionMetadata(child)
    metadata.aliases.forEach((alias) => result.aliases.add(alias))
    result.usesSelf ||= metadata.usesSelf
  }
  return result
}

export function compileChartExpression(source: string): CompiledChartExpression {
  const normalized = source.trim()
  if (!normalized) throw new ChartExpressionError('公式不能为空。')
  if (normalized.length > MAX_EXPRESSION_LENGTH) {
    throw new ChartExpressionError(`公式最多包含 ${MAX_EXPRESSION_LENGTH} 个字符。`)
  }
  const ast = new Parser(tokenize(normalized)).parse()
  const metadata = collectExpressionMetadata(ast)
  return {
    source: normalized,
    unit: formatChartDimension(ast.dimension),
    referencedAliases: [...metadata.aliases].sort(),
    usesSelf: metadata.usesSelf,
    evaluate: (context) => evaluateNode(ast, context),
  }
}
