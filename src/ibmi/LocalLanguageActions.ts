import { Action } from "./types.js";

/**
 * Built-in actions. Streamfile actions compile an IFS source file
 * (&RELATIVEPATH / &FULLPATH); member actions compile a source member
 * (&OPENLIB / &OPENSPF / &OPENMBR). Running an action against the other kind
 * of target is refused.
 */

export const LocalLanguageActions: Record<string, Action[]> = {
  RPGLE: [
    {
      type: `streamfile`,
      name: `Create RPGLE Program`,
      command: `CRTBNDRPG PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`RPGLE`]
    },
    {
      type: `streamfile`,
      name: `Create RPGLE Module`,
      command: `CRTRPGMOD MODULE(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`RPGLE`]
    },
    {
      type: `streamfile`,
      name: `Create SQLRPGLE Program`,
      command: `CRTSQLRPGI OBJ(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) CLOSQLCSR(*ENDMOD) CVTCCSID(*JOB) COMPILEOPT('TGTCCSID(*JOB)') RPGPPOPT(*LVL2)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`SQLRPGLE`]
    },
    {
      type: `streamfile`,
      name: `Create SQLRPGLE Module`,
      command: `CRTSQLRPGI OBJ(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OBJTYPE(*MODULE) OPTION(*EVENTF) DBGVIEW(*SOURCE) CLOSQLCSR(*ENDMOD) CVTCCSID(*JOB) COMPILEOPT('TGTCCSID(*JOB)') RPGPPOPT(*LVL2)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`SQLRPGLE`]
    }
  ],
  COBOL: [
    {
      type: `streamfile`,
      name: `Create COBOL Program (SQL)`,
      command: `CRTSQLCBLI OBJ(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) CLOSQLCSR(*ENDMOD) CVTCCSID(*JOB) TOSRCFILE(&CURLIB/QSQLTEMP)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`SQLCBL`, `SQLCBBLE`, `SQLCBLLE`, `COB`, `CBLLE`, `CBL`, `CBBLE`]
    },
    {
      type: `streamfile`,
      name: `Create COBOL Module (SQL)`,
      command: `CRTSQLCBLI OBJ(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OBJTYPE(*MODULE) OPTION(*EVENTF) DBGVIEW(*SOURCE) CLOSQLCSR(*ENDMOD) CVTCCSID(*JOB) TOSRCFILE(&CURLIB/QSQLTEMP)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`SQLCBL`, `SQLCBBLE`, `SQLCBLLE`, `COB`, `CBLLE`, `CBL`, `CBBLE`]
    }
  ],
  C: [
    {
      type: `streamfile`,
      name: `Create C Program`,
      command: `CRTBNDC PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`C`]
    },
    {
      type: `streamfile`,
      name: `Create C Module`,
      command: `CRTCMOD MODULE(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`C`]
    }
  ],
  CPP: [
    {
      type: `streamfile`,
      name: `Create CPP Program`,
      command: `CRTBNDCPP PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`CPP`]
    },
    {
      type: `streamfile`,
      name: `Create CPP Module`,
      command: `CRTCPPMOD MODULE(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTCCSID(*JOB)`,
      deployFirst: true,
      environment: `ile`,
      extensions: [`CPP`]
    }
  ],
  CLLE: [
    {
      type: `streamfile`,
      extensions: [`CLP`, `CLLE`],
      name: `Create Bound CL Program`,
      command: `CRTBNDCL PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      deployFirst: true,
      environment: `ile`
    }
  ],
  CMD: [
    {
      type: `streamfile`,
      extensions: [`cmd`],
      name: `Create Command`,
      command: `CRTCMD CMD(&CURLIB/&NAME) PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF)`,
      deployFirst: true,
      environment: `ile`
    }
  ],
  SQL: [
    {
      type: `streamfile`,
      extensions: [`SQL`, `TABLE`, `VIEW`, `SQLPRC`, `SQLUDF`, `SQLUDT`, `SQLTRG`, `SQLALIAS`, `SQLSEQ`],
      name: `Run SQL Statements (RUNSQLSTM)`,
      command: `RUNSQLSTM SRCSTMF('&FULLPATH') COMMIT(*NONE) NAMING(*SQL)`,
      deployFirst: true,
      environment: `ile`
    }
  ],
  DSPF: [
    {
      type: "member",
      name: "Create DSPF",
      command: "CRTDSPF FILE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) RSTDSP(*NO) OPTION(*EVENTF)",
      environment: "ile",
      extensions: ["DSPF"]
    }
  ],
  "Service Programs": [
    {
      extensions: [`GLOBAL`],
      name: `Create Service Program (CRTSRVPGM EXPORT(*ALL))`,
      command: `CRTSRVPGM SRVPGM(&CURLIB/&NAME) EXPORT(*ALL) BNDSRVPGM(*NONE) BNDDIR(*NONE) ACTGRP(*CALLER)`,
      environment: `ile`
    },
    {
      type: `streamfile`,
      extensions: ["BND", "BINDER"],
      deployFirst: true,
      name: "Create Service Program (CRTSRVPGM with source)",
      command: "CRTSRVPGM SRVPGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') BNDSRVPGM(*NONE) BNDDIR(*NONE) ACTGRP(*CALLER)",
      environment: "ile"
    }
  ],
  "GNU Make": [
    {
      type: `streamfile`,
      extensions: [`GLOBAL`],
      name: `Build all with gmake`,
      command: `/QOpenSys/pkgs/bin/gmake BUILDLIB=&CURLIB ERR=*EVENTF`,
      environment: `pase`,
      deployFirst: true
    },
    {
      type: `streamfile`,
      extensions: [`GLOBAL`],
      name: `Build current with gmake`,
      command: `/QOpenSys/pkgs/bin/gmake &BASENAME BUILDLIB=&CURLIB ERR=*EVENTF`,
      environment: `pase`,
      deployFirst: true
    }
  ],
  "The Object Builder for i (TOBi)": [
    {
      type: `streamfile`,
      extensions: [`GLOBAL`],
      name: `Build all with TOBi`,
      command: `OPT=*EVENTF BUILDLIB=&CURLIB /QOpenSys/pkgs/bin/makei build`,
      environment: `pase`,
      deployFirst: true,
      postDownload: [".logs", ".evfevent"]
    },
    {
      type: `streamfile`,
      extensions: [`GLOBAL`],
      name: `Build current with TOBi`,
      command: `OPT=*EVENTF BUILDLIB=&CURLIB /QOpenSys/pkgs/bin/makei compile -f &BASENAME`,
      environment: `pase`,
      deployFirst: true,
      postDownload: [".logs", ".evfevent"]
    }
  ],
  "Source Orbit": [
    {
      type: `streamfile`,
      name: "Build current with Source Orbit",
      command: "so -bf make -s &RELATIVEPATH && /QOpenSys/pkgs/bin/gmake LIBL='&LIBLS' BIN_LIB=&CURLIB OPT=*EVENTF",
      environment: "pase",
      deployFirst: true,
      extensions: ["GLOBAL"],
      postDownload: [".evfevent/"]
    },
    {
      type: `streamfile`,
      name: "Build entire project with Source Orbit",
      command: "so -bf make && /QOpenSys/pkgs/bin/gmake LIBL='&LIBLS' BIN_LIB=&CURLIB OPT=*EVENTF",
      environment: "pase",
      deployFirst: true,
      extensions: ["GLOBAL"],
      postDownload: [".evfevent/"]
    }
  ],
  "Source Members": [
    {
      type: `member`,
      name: `Create Bound RPG Program (CRTBNDRPG)`,
      command: `CRTBNDRPG PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`RPGLE`, `RPG`]
    },
    {
      type: `member`,
      name: `Create RPG Module (CRTRPGMOD)`,
      command: `CRTRPGMOD MODULE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`RPGLE`, `RPG`]
    },
    {
      type: `member`,
      name: `Create SQL ILE RPG Program (CRTSQLRPGI)`,
      command: `CRTSQLRPGI OBJ(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) CLOSQLCSR(*ENDMOD) OPTION(*EVENTF) DBGVIEW(*SOURCE) CVTCCSID(*JOB)`,
      environment: `ile`,
      extensions: [`SQLRPGLE`]
    },
    {
      type: `member`,
      name: `Create SQL ILE RPG Module (CRTSQLRPGI)`,
      command: `CRTSQLRPGI OBJ(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OBJTYPE(*MODULE) CLOSQLCSR(*ENDMOD) OPTION(*EVENTF) DBGVIEW(*SOURCE) CVTCCSID(*JOB)`,
      environment: `ile`,
      extensions: [`SQLRPGLE`]
    },
    {
      type: `member`,
      name: `Create Bound COBOL Program (CRTBNDCBL)`,
      command: `CRTBNDCBL PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`CBLLE`]
    },
    {
      type: `member`,
      name: `Create SQL ILE COBOL Program (CRTSQLCBLI)`,
      command: `CRTSQLCBLI OBJ(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) CLOSQLCSR(*ENDMOD) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`SQLCBLLE`]
    },
    {
      type: `member`,
      name: `Create Bound C Program (CRTBNDC)`,
      command: `CRTBNDC PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`C`]
    },
    {
      type: `member`,
      name: `Create Bound CL Program (CRTBNDCL)`,
      command: `CRTBNDCL PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`CLLE`]
    },
    {
      type: `member`,
      name: `Create CL Module (CRTCLMOD)`,
      command: `CRTCLMOD MODULE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
      environment: `ile`,
      extensions: [`CLLE`]
    },
    {
      type: `member`,
      name: `Create Command (CRTCMD)`,
      command: `CRTCMD CMD(&OPENLIB/&OPENMBR) PGM(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF)`,
      environment: `ile`,
      extensions: [`CMD`]
    },
    {
      type: `member`,
      name: `Create Physical File (CRTPF)`,
      command: `CRTPF FILE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF)`,
      environment: `ile`,
      extensions: [`PF`]
    },
    {
      type: `member`,
      name: `Create Logical File (CRTLF)`,
      command: `CRTLF FILE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF)`,
      environment: `ile`,
      extensions: [`LF`]
    },
    {
      type: `member`,
      name: `Create Printer File (CRTPRTF)`,
      command: `CRTPRTF FILE(&OPENLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) OPTION(*EVENTF)`,
      environment: `ile`,
      extensions: [`PRTF`]
    },
    {
      type: `member`,
      name: `Run SQL Statements from member (RUNSQLSTM)`,
      command: `RUNSQLSTM SRCFILE(&OPENLIB/&OPENSPF) SRCMBR(&OPENMBR) COMMIT(*NONE) NAMING(*SQL)`,
      environment: `ile`,
      extensions: [`SQL`]
    }
  ]
};
