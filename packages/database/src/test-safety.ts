/** Integration fixtures must fail closed before opening a production connection. */
export function assertLocalTestDatabase() {
  const value = process.env.DATABASE_URL;
  if (!value)
    throw new Error(
      "Integration tests require an explicit local test DATABASE_URL",
    );
  const url = new URL(value);
  if (
    process.env.NODE_ENV !== "test" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error(
      "Integration tests are restricted to local databases ending in _test with NODE_ENV=test",
    );
}
