import { invalidScimValue, normalizeScimAttributePath, type ScimRequestError } from "./protocol";

const FILTER_MAX_LENGTH = 1_024;
const FILTER_MAX_CLAUSES = 4;
const FILTER_VALUE_MAX_LENGTH = 512;
const ATTRIBUTE_PATH = /^[A-Za-z][A-Za-z0-9:._$-]*/u;

export type ScimFilterClause<Attribute extends string = string> = {
  attribute: Attribute;
  value: string;
};

/** Normalized attribute paths a filter may use, mapped to the attribute they compare. */
export type ScimFilterAttributes<Attribute extends string> = Readonly<Record<string, Attribute>>;

export const SCIM_USER_FILTER_ATTRIBUTES = {
  emails: "emails.value",
  "emails.value": "emails.value",
  externalid: "externalId",
  id: "id",
  username: "userName"
} as const satisfies ScimFilterAttributes<string>;

export const SCIM_GROUP_FILTER_ATTRIBUTES = {
  displayname: "displayName",
  externalid: "externalId",
  id: "id",
  members: "members.value",
  "members.value": "members.value"
} as const satisfies ScimFilterAttributes<string>;

export type ScimUserFilterAttribute = (typeof SCIM_USER_FILTER_ATTRIBUTES)[keyof typeof SCIM_USER_FILTER_ATTRIBUTES];
export type ScimGroupFilterAttribute = (typeof SCIM_GROUP_FILTER_ATTRIBUTES)[keyof typeof SCIM_GROUP_FILTER_ATTRIBUTES];

function invalidFilter(): ScimRequestError {
  return invalidScimValue(
    "Supported filters: <attribute> eq \"<value>\", joined by and, and members[value eq \"<id>\"].",
    "invalidFilter"
  );
}

/**
 * Parses the filters SCIM clients send to find one resource: `<attribute> eq "<value>"` clauses
 * joined by `and`, plus the value-path form `members[value eq "<id>"]`. Attribute names and
 * keywords are case-insensitive and may carry the core schema URN. Anything else (`or`, `not`,
 * other operators, grouping, unknown attributes, non-string values) is `invalidFilter`.
 */
export function parseScimFilter<Attribute extends string>(
  filter: string,
  attributes: ScimFilterAttributes<Attribute>
): ScimFilterClause<Attribute>[] {
  if (filter.length > FILTER_MAX_LENGTH) throw invalidFilter();
  let position = 0;

  const skipSpaces = () => {
    while (position < filter.length && /\s/u.test(filter[position]!)) position += 1;
  };
  const word = (): string => {
    skipSpaces();
    const match = ATTRIBUTE_PATH.exec(filter.slice(position));
    if (!match) throw invalidFilter();
    position += match[0].length;
    return match[0];
  };
  const keyword = (expected: string) => {
    if (word().toLowerCase() !== expected) throw invalidFilter();
  };
  const stringLiteral = (): string => {
    skipSpaces();
    if (filter[position] !== "\"") throw invalidFilter();
    let end = position + 1;
    while (end < filter.length && filter[end] !== "\"") end += filter[end] === "\\" ? 2 : 1;
    if (end >= filter.length) throw invalidFilter();
    let value: unknown;
    try {
      value = JSON.parse(filter.slice(position, end + 1));
    } catch {
      throw invalidFilter();
    }
    position = end + 1;
    if (typeof value !== "string" || value.length > FILTER_VALUE_MAX_LENGTH) throw invalidFilter();
    return value;
  };

  const clauses: ScimFilterClause<Attribute>[] = [];
  while (true) {
    let path = word();
    let value: string;
    skipSpaces();
    if (filter[position] === "[") {
      position += 1;
      keyword("value");
      keyword("eq");
      value = stringLiteral();
      skipSpaces();
      if (filter[position] !== "]") throw invalidFilter();
      position += 1;
      path = `${path}.value`;
    } else {
      keyword("eq");
      value = stringLiteral();
    }
    const attribute = attributes[normalizeScimAttributePath(path)];
    if (!attribute || clauses.length >= FILTER_MAX_CLAUSES) throw invalidFilter();
    clauses.push({ attribute, value });
    skipSpaces();
    if (position >= filter.length) return clauses;
    keyword("and");
  }
}
