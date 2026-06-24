function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateType(expectedType, value) {
  if (expectedType === "object") return isPlainObject(value);
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expectedType;
}

function looksLikeDateTime(value) {
  if (typeof value !== "string" || !value.includes("T")) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    addError(errors, path, `must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    addError(errors, path, `must be one of: ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  if (schema.type) {
    if (!validateType(schema.type, value)) {
      addError(errors, path, `must be type ${schema.type}`);
      return;
    }
  }

  if (schema.type === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      addError(errors, path, `must have length >= ${schema.minLength}`);
    }
    if (schema.format === "date-time" && !looksLikeDateTime(value)) {
      addError(errors, path, "must be a valid date-time string");
    }
    if (typeof schema.pattern === "string") {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        addError(errors, path, `must match pattern ${schema.pattern}`);
      }
    }
    return;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addError(errors, path, `must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addError(errors, path, `must be <= ${schema.maximum}`);
    }
    return;
  }

  if (schema.type === "array") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addError(errors, path, `must contain at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addError(errors, path, `must contain at most ${schema.maxItems} item(s)`);
    }

    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => {
        validateValue(schema.items, item, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (schema.type === "object") {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        addError(errors, path, `missing required property: ${key}`);
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateValue(propertySchema, value[key], `${path}.${key}`, errors);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          addError(errors, `${path}.${key}`, "unexpected property");
        }
      }
    }
  }
}

export function validateJsonSchema(schema, payload) {
  const errors = [];
  validateValue(schema, payload, "$", errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}
