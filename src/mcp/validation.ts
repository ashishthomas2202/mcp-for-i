type JsonSchema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
};

export function validateToolInput(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateNode(schema, value, "$", errors);
  return errors;
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]) {
  if (!matchesType(schema.type, value)) {
    const typeText = Array.isArray(schema.type) ? schema.type.join("|") : schema.type || "unknown";
    errors.push(`${path} must be ${typeText}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`);
    return;
  }

  if (isObjectSchema(schema, value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${path}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (obj[key] !== undefined) {
          validateNode(propSchema, obj[key], `${path}.${key}`, errors);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, idx) => validateNode(schema.items!, entry, `${path}[${idx}]`, errors));
  }
}

function isObjectSchema(schema: JsonSchema, value: unknown) {
  const types = toTypes(schema.type);
  return types.includes("object") && isPlainObject(value);
}

function matchesType(type: string | string[] | undefined, value: unknown) {
  if (!type) return true;
  const accepted = toTypes(type);
  return accepted.some(t => isType(t, value));
}

function toTypes(type: string | string[] | undefined) {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}

function isType(type: string, value: unknown) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "null") return value === null;
  return true;
}

function isPlainObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
