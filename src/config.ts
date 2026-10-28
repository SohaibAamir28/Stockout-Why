/**
 * Loads configuration from .env and fails loudly when something required
 * is missing, so a run never half-works against a placeholder.
 */

try {
  process.loadEnvFile('.env');
} catch {
  // No .env yet. Individual getters report what is missing.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is missing from .env. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export const zetaris = {
  /** Web UI, used only by the smoke test. */
  get baseUrl() {
    return optional('ZETARIS_BASE_URL', 'http://localhost:3000');
  },
  get restUrl() {
    return required('ZETARIS_REST_URL').replace(/\/+$/, '');
  },
  get orgId() {
    return optional('ZETARIS_ORG_ID', '1');
  },
  get apiKey() {
    return required('ZETARIS_API_KEY');
  },
  /**
   * The Zetaris datasource the business tables are registered under. Queries
   * name tables as `<source>.<table>`, as Lightning SQL requires.
   */
  get source() {
    const source = optional('ZETARIS_SOURCE', 'retail');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(source)) {
      throw new Error(`ZETARIS_SOURCE must be a plain identifier, got ${JSON.stringify(source)}`);
    }
    return source;
  },
};

/**
 * The retailer's operational database: a Postgres container on the Zetaris
 * Docker network, registered in Zetaris as a datasource. Only the loader uses
 * this; the agent itself never connects to it, it goes through Zetaris.
 */
export const retailDb = {
  get password() {
    return required('RETAIL_DB_PASSWORD');
  },
  /** How the Zetaris query engine reaches it, inside Docker. */
  get jdbcUrl() {
    return optional('RETAIL_DB_JDBC_URL', 'jdbc:postgresql://retail-db:5432/retail');
  },
};

export const meterless = {
  get baseUrl() {
    return optional('METERLESS_BASE_URL', 'http://127.0.0.1:8088/v1').replace(
      /\/+$/,
      '',
    );
  },
  get token() {
    const token = required('METERLESS_RUNTIME_TOKEN');
    // The runtime rejects this placeholder; catch it before a confusing 401.
    if (token === 'rt-local') {
      throw new Error(
        'METERLESS_RUNTIME_TOKEN is the placeholder "rt-local". Copy the real ' +
          'Runtime token from Nightshift > Console.',
      );
    }
    return token;
  },
  get app() {
    return optional('METERLESS_APP', 'stockout-why');
  },
  get model() {
    return optional('METERLESS_MODEL', 'meterless/auto');
  },
};

/** Where H-MEM keeps its tiers on disk. */
export const hmemDir = optional('HMEM_DIR', '.hmem');
