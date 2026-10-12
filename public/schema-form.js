// Conditions narrow existing fields; the server still validates their relationships.
export function schemaHasComplexRoot(schema) {
  if (schema.oneOf || schema.anyOf || (schema.type && schema.type !== 'object')) return true;
  if (!schema.allOf) return false;
  const known = new Set(Object.keys(schema.properties || {}));
  const knownFields = branch => branch && typeof branch === 'object' &&
    Object.keys(branch).every(key => ['required', 'properties'].includes(key)) &&
    (!branch.required || (Array.isArray(branch.required) && branch.required.every(key => known.has(key)))) &&
    (!branch.properties || Object.keys(branch.properties).every(key => known.has(key)));
  return !Array.isArray(schema.allOf) || schema.allOf.some(condition =>
    !condition || typeof condition !== 'object' || !condition.if || !condition.then ||
    Object.keys(condition).some(key => !['if', 'then', 'else'].includes(key)) ||
    !knownFields(condition.if) || !knownFields(condition.then) ||
    (condition.else !== undefined && !knownFields(condition.else)));
}
