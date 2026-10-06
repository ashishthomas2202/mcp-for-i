# Examples

## Add connection profile
```json
{
  "tool": "ibmi.connections.add",
  "arguments": {
    "name": "DEV400",
    "host": "dev400.myco.com",
    "port": 22,
    "username": "DEVUSER",
    "policy": { "profile": "guarded" }
  }
}
```

Set or update the password through the local control-plane UI so it can be stored in the operating-system credential store; MCP tool arguments do not accept secrets.

## Connect by saved name
```json
{
  "tool": "ibmi.connect",
  "arguments": { "name": "DEV400" }
}
```

## List libraries
```json
{
  "tool": "ibmi.qsys.libraries.list",
  "arguments": { "filter": "*ALL" }
}
```

## Read a member
```json
{
  "tool": "ibmi.qsys.members.read",
  "arguments": {
    "library": "MYLIB",
    "sourceFile": "QRPGLESRC",
    "member": "MYPGM"
  }
}
```

## Inspect a member in one versioned operation

```json
{
  "tool": "ibmi.source.inspect",
  "arguments": {
    "connectionName": "DEV400",
    "library": "MYLIB",
    "member": "MYPGM",
    "candidateSourceFiles": ["QRPGLESRC", "QCLSRC"],
    "operations": [
      { "operation": "metadata" },
      { "operation": "outline" },
      { "operation": "search", "terms": ["PCFCID", "CHAIN"], "before": 2, "after": 3 },
      { "operation": "read_ranges", "ranges": [{ "start": 120, "end": 180 }] },
      { "operation": "dependencies" }
    ]
  }
}
```

Use the returned `version` or `sha256` as `expectedVersion` / `expectedSha256` on a later structured read or member write.

## Search official IBM i documentation

```json
{
  "tool": "ibmi.docs.search",
  "arguments": {
    "query": "QSYS2 SQL services HTTP functions",
    "connectionName": "DEV400",
    "limit": 5
  }
}
```

## Run an action
```json
{
  "tool": "ibmi.actions.run",
  "arguments": {
    "actionName": "Create RPGLE Program",
    "targetType": "member",
    "targetPath": "MYLIB/QRPGLESRC/MYPGM",
    "library": "MYLIB",
    "sourceFile": "QRPGLESRC",
    "member": "MYPGM",
    "extension": "RPGLE"
  }
}
```

## Activate a profile
```json
{
  "tool": "ibmi.profiles.activate",
  "arguments": {
    "connectionName": "DEV400",
    "name": "projectA",
    "applyToJob": true
  }
}
```
