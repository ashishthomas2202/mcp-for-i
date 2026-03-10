# Examples

## Connect (direct)
```json
{
  "tool": "ibmi.connect",
  "arguments": {
    "host": "dev400.myco.com",
    "port": 22,
    "username": "DEVUSER",
    "password": "*****",
    "storePassword": true
  }
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
