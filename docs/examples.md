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
    "password": "*****",
    "storePassword": true,
    "policy": { "profile": "guarded" }
  }
}
```

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
