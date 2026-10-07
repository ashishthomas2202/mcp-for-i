import { IBMiClient } from "./client.js";

export class Variables extends Map<string, string> {
  constructor(connection?: IBMiClient, variables?: Record<string, string> | Map<string, string>) {
    super(variables instanceof Map ? variables : variables ? Object.entries(variables) : new Map());

    if (connection) {
      const config = connection.getConfig();
      this.set(`&BUILDLIB`, this.get(`&CURLIB`) || config.currentLibrary || "");
      if (!this.has(`&CURLIB`)) {
        this.set(`&CURLIB`, config.currentLibrary || "");
      }
      if (!this.has(`\\*CURLIB`)) {
        this.set(`\\*CURLIB`, config.currentLibrary || "");
      }
      this.set(`&USERNAME`, connection.currentUser)
        .set(`{usrprf}`, connection.currentUser)
        .set(`&HOST`, connection.currentHost)
        .set(`{host}`, connection.currentHost)
        .set(`&HOME`, config.homeDirectory || ".")
        .set(`&WORKDIR`, config.homeDirectory || ".");

      for (const variable of config.customVariables || []) {
        this.set(`&${variable.name.toUpperCase()}`, variable.value || "");
      }
    }
  }

  set(key: string, value: string): this {
    super.set(key, value);
    this.expandVariables();
    return this;
  }

  private expandVariables() {
    for (const [key, value] of this.entries()) {
      super.set(key, this.expand(value, [key]));
    }
  }

  /**
   * Replace every variable in one pass. Longer names are tried first and a
   * name that ends in a letter or digit only matches when the next character
   * is not part of a name, so `&EXT` never replaces the start of `&EXTL` and
   * `&OPENLIB` never replaces the start of `&OPENLIBL`.
   */
  public expand(input: string, keysToOmit: string[] = []) {
    const keys = Array.from(this.keys())
      .filter(key => key.length > 0 && !keysToOmit.includes(key))
      .sort((a, b) => b.length - a.length);
    if (keys.length === 0) return input;
    const pattern = keys
      .map(key => {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return /[A-Za-z0-9_#@$]$/.test(key) ? `${escaped}(?![A-Za-z0-9_#@$])` : escaped;
      })
      .join("|");
    return input.replace(new RegExp(pattern, "g"), match => this.get(match) ?? match);
  }

  toPaseVariables(): Record<string, string> {
    const variables: Record<string, string> = {};
    for (const [key, value] of this.entries()) {
      const cleanKey = key.startsWith('&') ? key.substring(1) : key;
      if ((/^[a-z_]\w*$/i).test(cleanKey)) {
        variables[cleanKey] = value;
      }
    }
    return variables;
  }
}
