/** Valida o destino antes de qualquer conexão ou migration de testes. */
export function requireTestDatabaseUrl(testUrl: string, mainUrl?: string): string {
  const target = new URL(testUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !/test|verify/i.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL deve usar PostgreSQL e um banco com test ou verify no nome.');
  }
  if (mainUrl) {
    const main = new URL(mainUrl);
    // Mesmo nome é recusado inclusive com aliases de host, credenciais ou query diferentes.
    if (decodeURIComponent(main.pathname.slice(1)) === databaseName) {
      throw new Error('TEST_DATABASE_URL deve apontar para um banco distinto de DATABASE_URL.');
    }
  }
  return testUrl;
}
