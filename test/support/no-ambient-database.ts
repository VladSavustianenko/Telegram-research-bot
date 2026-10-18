// Tests must pass connection details explicitly: fakes for unit tests, the
// injected disposable database for integration tests. Removing the ambient
// DATABASE_URL (possibly loaded from a developer's .env) makes accidental use
// of a development or production database fail instead of succeed.
delete process.env['DATABASE_URL'];
