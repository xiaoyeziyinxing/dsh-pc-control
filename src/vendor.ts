// 内联 helper（vendor）：npm 上 dsh 包滞后/受限，无法作依赖安装。
// 行为对齐 dsh@1517a4db 源码：core/tools/src/schema.ts 的 defineTool 最小等价。
// 与 dsh-emotion / dsh-reboot vendor 同源，仅保留本插件用到的 defineTool。

export interface ToolParam { type?: string; description?: string; required?: boolean }
export interface ToolOptions {
  name: string
  description: string
  parameters?: Record<string, ToolParam>
  output?: { type?: string; schema?: Record<string, unknown>; render?: (args: unknown, value: unknown) => unknown[] }
  execute: (args: Record<string, unknown>, exec?: unknown) => unknown
}

/** 参数 DSL → JSON Schema（schema.ts parameterSchemaSpecToJsonSchema 的最小等价） */
function paramsToJsonSchema(params: Record<string, ToolParam> | undefined) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(params || {})) {
    properties[name] = { type: p.type, description: p.description || '' }
    if (p.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** defineTool：产出 registry 可用的 ToolDefinition（schema.ts:553-600 最小等价） */
export function defineTool(options: ToolOptions) {
  const parameters = paramsToJsonSchema(options.parameters)
  const output = options.output || {}
  // {type:'json'} 是 DSL：转成"任意 JSON"的空 JSON Schema（schema.ts valueSchemaSpecToJsonSchema 等价）
  const outSchema = (output as { schema?: { type?: string } }).schema?.type === 'json'
    ? {}
    : ((output as { schema?: Record<string, unknown> }).schema || {})
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outSchema,
      render: (args: unknown, value: unknown) =>
        output.render ? output.render(args, value) : [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: Record<string, unknown> | undefined, exec?: unknown) {
      // 参数校验：必填缺失即抛（ToolArgsError 语义简化为 Error）
      const missing = ((parameters as { required?: string[] }).required || [])
        .filter((k) => args?.[k] === undefined)
      if (missing.length) throw new Error(`missing required argument(s): ${missing.join(', ')}`)
      return options.execute(args ?? {}, exec)
    },
  }
}
