import * as commandLineArgs from "command-line-args"
import * as commandLineUsage from "command-line-usage"
import * as readline from "readline"

import {log} from "./log"
import {ChargerSimulator} from "./ChargerSimulator"

const optionList = [
  {
    name: "csURL",
    type: String,
    description:
      "URL of the Central System server to connect to, ws://server.name/path.\nThis is also a default option.",
    typeLabel: "{underline URL}",
    alias: "s",
    defaultOption: true,
  },
  {
    name: "cpPort",
    type: Number,
    description:
      "Port number to bind ChargePoint SOAP service. If specified, emulator will use SOAP protocol to connect to Central System, otherwise, WebSocket will be used",
    typeLabel: "{underline Number}",
    alias: "p",
  },
  {
    name: "chargerId",
    type: String,
    description: "OCPP ID to be used for simulating charger.\nDefault is 'test'.",
    typeLabel: "{underline ChargerId}",
    alias: "i",
    defaultValue: "test1",
  },
  {
    name: "connectorId",
    type: String,
    description: "ID of the connector to send status when pressing keys.\nDefaults to 1.",
    typeLabel: "{underline ConnectorId}",
    alias: "c",
    defaultValue: 1,
  },
  {
    name: "idTag",
    type: String,
    description: "ID Tag to start transaction.\nDefaults to 123456.",
    typeLabel: "{underline idTag}",
    alias: "t",
    defaultValue: "12345678",
  },
]

const usageSections = [
  {
    header: "charger-simulator",
    content: "Start OCPP charging station simulator, connect simulator to Central System server.",
  },
  {
    header: "Options",
    optionList,
  },
]

;(async () => {
  const {connectorId, csURL, cpPort, chargerId, idTag} = commandLineArgs(optionList)

  if (!connectorId || !csURL || !chargerId) {
    const usage = commandLineUsage(usageSections)
    console.log(usage)
    return
  }

  log.info("Starting charger simulator", {
    csURL,
    connectorId,
    chargerId,
    idTag,
  })

  const simulator = new ChargerSimulator({
    centralSystemEndpoint: csURL,
    chargerIdentity: chargerId,
    chargePointPort: cpPort,
  })
  await simulator.start()

  log.info(`Supported keys:
    Ctrl+C:   quit
    
    --
    b:        send BootNotification
    o:        send BootNotification with optional parameters
    d:        send DataTransfer
    D:        disconnect from Central System
    
    Connector ${connectorId} status
    ---
    A:        send Available status 
    U:        send Unavailable status
    P:        send Preparing status
    C:        send Charging status
    F:        send Finishing status
    
    Transaction on connector ${connectorId}, tag ${idTag}
    --
    u:        Authorize
    s:        StartTransaction
    t:        StopTransaction

    Debug
    --
    p:        Print current configuration
  `)

  async function sendStatus(status: string) {
    await simulator.centralSystem.StatusNotification({
      connectorId: connectorId,
      errorCode: "NoError",
      status,
    })
  }

  const commands = {
    b: () =>
      simulator.centralSystem.BootNotification({
        chargePointVendor: "Mock",
        chargePointModel: "Simulator",
      }),
    o: () =>
      simulator.centralSystem.BootNotification({
        chargePointVendor: "OC",
        chargePointModel: "OCX",
        chargePointSerialNumber: "1234-5678",
        meterSerialNumber: "1234-5678-AA-BB",
        firmwareVersion: "AA-001",
        iccid: "OMEGA-PEPEGA",
        imsi: "ENERGY-001",
      }),
    d: () =>
      simulator.centralSystem.DataTransfer({
        vendorId: "Emulator",
        messageId: "MessageID",
        data: "Data",
      }),

    D: () => simulator.disconnect(),

    E: () => sendStatus("SuspendedEV"),
    A: () => sendStatus("Available"),
    P: () => sendStatus("Preparing"),
    C: () => sendStatus("Charging"),
    F: () => sendStatus("Finishing"),
    U: () => sendStatus("Unavailable"),

    u: () => simulator.centralSystem.Authorize({idTag}),
    s: () => simulator.startTransaction({idTag, connectorId}, false),
    t: () => simulator.stopTransaction({}, false),

    p: () => simulator.printConf(),
  }

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)

  process.stdin.on("keypress", (ch, key) => {
    if (key.ctrl && key.name === "c") {
      process.exit()
    }

    if (ch) {
      const command = commands[ch]
      command && command()
    }
  })
})()
