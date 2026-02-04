import fs from "fs";
const levelOrder = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};
const argv = process.argv.slice(2);
const argLevel = argv.find(a => a.startsWith("--log-level="))?.split("=", 2)[1] || "";
const argFile = argv.find(a => a.startsWith("--log-file="))?.split("=", 2)[1] || "";
const argEnable = argv.includes("--log") || argv.includes("--log-stderr") || Boolean(argLevel) || Boolean(argFile);
const envLevel = process.env.MCP_FOR_I_LOG_LEVEL || "";
const envFile = process.env.MCP_FOR_I_LOG || "";
const envEnable = process.env.MCP_FOR_I_LOG_ENABLED === "1" || process.env.MCP_FOR_I_LOG_ENABLED === "true";
const envStderrFlag = process.env.MCP_FOR_I_LOG_STDERR;
const loggingEnabled = argEnable || envEnable || Boolean(envLevel) || Boolean(envFile) || (envStderrFlag && envStderrFlag !== "0");
const configuredLevel = (argLevel || envLevel || "info").toLowerCase();
const activeLevel = levelOrder[configuredLevel] !== undefined ? configuredLevel : "info";
const logFile = argFile || envFile || "";
const logToStderr = argv.includes("--log") || argv.includes("--log-stderr") || (envStderrFlag ? envStderrFlag !== "0" : false);
function shouldLog(level) {
    return levelOrder[level] <= levelOrder[activeLevel];
}
function safeWrite(line) {
    if (logFile) {
        try {
            fs.appendFileSync(logFile, line + "\n");
        }
        catch {
            // Ignore file errors; fall back to stderr
        }
    }
    if (logToStderr || !logFile) {
        process.stderr.write(line + "\n");
    }
}
export function redact(value) {
    const secretKeys = ["password", "pass", "token", "secret", "key", "privatekey"];
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const lower = k.toLowerCase();
            if (secretKeys.some(s => lower.includes(s))) {
                out[k] = "***";
            }
            else {
                out[k] = redact(v);
            }
        }
        return out;
    }
    if (typeof value === "string" && value.length > 500) {
        return value.substring(0, 500) + "...(truncated)";
    }
    return value;
}
export function log(level, message, meta) {
    if (!loggingEnabled)
        return;
    if (!shouldLog(level))
        return;
    const ts = new Date().toISOString();
    const payload = meta ? ` ${JSON.stringify(redact(meta))}` : "";
    if (!logToStderr && !logFile) {
        // if logging is enabled but no output configured, default to stderr
        process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}${payload}\n`);
        return;
    }
    safeWrite(`[${ts}] [${level.toUpperCase()}] ${message}${payload}`);
}
