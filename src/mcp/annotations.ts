/**
 * MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint) for the built-in tools, so clients can auto-approve safe
 * tools and warn before destructive ones. Tools that already declare
 * annotations (the module tools) keep their own.
 */
export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// Tools that only read from the IBM i, the local config or the audit log.
const READ_ONLY = new Set([
  "ibmi.session.list",
  "ibmi.session.status",
  "ibmi.session.keepalive",
  "ibmi.session.bootstrap",
  "ibmi.connections.list",
  "ibmi.qsys.libraries.list",
  "ibmi.qsys.objects.list",
  "ibmi.qsys.sourcefiles.list",
  "ibmi.qsys.members.list",
  "ibmi.qsys.members.read",
  "ibmi.ifs.list",
  "ibmi.ifs.read",
  "ibmi.search.members",
  "ibmi.source.resolve",
  "ibmi.source.inspect",
  "ibmi.search.ifs",
  "ibmi.find.ifs",
  "ibmi.actions.list",
  "ibmi.libl.get",
  "ibmi.libl.validate",
  "ibmi.profiles.list",
  "ibmi.resolve.path",
  "ibmi.filters.list",
  "ibmi.ifs.shortcuts.list",
  "ibmi.debug.status",
  "ibmi.deploy.compare",
  "ibmi.sql.query",
  "ibmi.diagnostics.parseEvfevent",
  "ibmi.joblog.get",
  "ibmi.spool.list",
  "ibmi.spool.read",
  "ibmi.jobs.list",
  "ibmi.subsystems.list",
  "ibmi.subsystems.status",
  "ibmi.msgq.read",
  "ibmi.locks.list",
  "ibmi.authority.object.get",
  "ibmi.dataarea.read",
  "ibmi.audit.list",
  "ibmi.audit.verify",
  "ibmi.journal.objects.list",
  "ibmi.journal.entries.query",
  "ibmi.qaudjrn.events.query",
  "ibmi.tn5250.readScreen",
  "ibmi.tn5250.waitFor",
  "ibmi.tn5250.snapshot"
]);

// Read-only tools that reach outside the IBM i and the local machine.
const OPEN_WORLD = new Set(["ibmi.docs.search", "ibmi.docs.open"]);

// Tools that can delete or overwrite data, end work, or run arbitrary commands.
const DESTRUCTIVE = new Set([
  "ibmi.connections.delete",
  "ibmi.qsys.members.write",
  "ibmi.qsys.members.delete",
  "ibmi.qsys.members.rename",
  "ibmi.ifs.write",
  "ibmi.ifs.delete",
  "ibmi.ifs.upload",
  "ibmi.ifs.download",
  "ibmi.actions.run",
  "ibmi.actions.delete",
  "ibmi.profiles.delete",
  "ibmi.filters.delete",
  "ibmi.ifs.shortcuts.delete",
  "ibmi.deploy.uploadDirectory",
  "ibmi.deploy.uploadFiles",
  "ibmi.deploy.sync",
  "ibmi.sql.execute",
  "ibmi.cl.run",
  "ibmi.spool.delete",
  "ibmi.jobs.end",
  "ibmi.subsystems.end",
  "ibmi.dataqueue.receive",
  "ibmi.dataarea.write",
  "ibmi.audit.export",
  "ibmi.audit.purge",
  "ibmi.journal.endPf",
  "ibmi.journal.endIfs",
  "ibmi.journal.receivers.retention",
  "ibmi.compliance.report.generate",
  "ibmi.tn5250.sendKeys"
]);

// Writes that leave the same end state when repeated with the same arguments.
const IDEMPOTENT_WRITES = new Set([
  "ibmi.connect",
  "ibmi.disconnect",
  "ibmi.session.terminate",
  "ibmi.connections.update",
  "ibmi.qsys.members.write",
  "ibmi.ifs.write",
  "ibmi.ifs.mkdir",
  "ibmi.ifs.upload",
  "ibmi.ifs.download",
  "ibmi.libl.set",
  "ibmi.libl.setCurrent",
  "ibmi.profiles.save",
  "ibmi.profiles.activate",
  "ibmi.actions.save",
  "ibmi.filters.save",
  "ibmi.deploy.setCcsid",
  "ibmi.spool.hold",
  "ibmi.spool.release",
  "ibmi.jobs.hold",
  "ibmi.jobs.release",
  "ibmi.dataarea.write",
  "ibmi.audit.export",
  "ibmi.tn5250.connect",
  "ibmi.tn5250.setField",
  "ibmi.tn5250.disconnect"
]);

export function annotationsFor(name: string): ToolAnnotations {
  if (READ_ONLY.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (OPEN_WORLD.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  // Anything not listed is treated as a write; unknown tools default to destructive.
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE.has(name) || !IDEMPOTENT_WRITES.has(name) && !isKnownNonDestructiveWrite(name),
    idempotentHint: IDEMPOTENT_WRITES.has(name),
    openWorldHint: false
  };
}

function isKnownNonDestructiveWrite(name: string) {
  return [
    "ibmi.connections.add",
    "ibmi.qsys.members.create",
    "ibmi.qsys.sourcefiles.create",
    "ibmi.qsys.libraries.create",
    "ibmi.libl.add",
    "ibmi.libl.remove",
    "ibmi.ifs.shortcuts.add",
    "ibmi.debug.startService",
    "ibmi.debug.stopService",
    "ibmi.spool.move",
    "ibmi.subsystems.start",
    "ibmi.msgq.send",
    "ibmi.msgq.reply",
    "ibmi.dataqueue.send",
    "ibmi.journal.receiver.create",
    "ibmi.journal.create",
    "ibmi.journal.receiver.change",
    "ibmi.journal.startPf",
    "ibmi.journal.startIfs"
  ].includes(name);
}

export function withAnnotations<T extends { name: string; annotations?: Record<string, any> }>(tool: T): T {
  if (tool.annotations) return tool;
  return { ...tool, annotations: annotationsFor(tool.name) };
}
