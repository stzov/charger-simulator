import {createRpcClient} from "@push-rpc/core"
import {wrapWebsocket} from "@push-rpc/websocket/dist/server"
import * as WebSocket from "ws"
import {log} from "./log"
import {createCentralSystemClient, createChargePointServer} from "./soap/ocppSoap"

export interface Config {
  defaultHeartbeatIntervalSec?: number
  chargePointVendor?: string
  chargePointModel?: string
  startDelayMs?: number
  stopDelayMs?: number
  keepAliveTimeoutMs?: number // set to null to disable pings
  meterValuesIntervalSec?: number

  centralSystemEndpoint: string
  chargerIdentity: string
  chargePointPort?: number
}

const defaultConfig: Partial<Config> = {
  defaultHeartbeatIntervalSec: 30,
  chargePointVendor: "Test",
  chargePointModel: "1",
  startDelayMs: 8 * 1000,
  stopDelayMs: 8 * 1000,
  keepAliveTimeoutMs: 50 * 1000,
  meterValuesIntervalSec: 20,
}

let ws: WebSocket

export class ChargerSimulator {
  constructor(config: Config) {
    this.config = {...defaultConfig, ...config}

    this.configurationKeys = [
      {key: "localAuthorizationList", readonly: false, value: []},
      {key: "HeartBeatInterval", readonly: false, value: "" + config.defaultHeartbeatIntervalSec},
      {key: "ResetRetries", readonly: false, value: "1"},
      {key: "MeterValueSampleInterval", readonly: false, value: config.meterValuesIntervalSec},
      {key: "NumberOfConnectors", readonly: true, value: "2"},
      {key: "ChargePointVendor", readonly: true, value: "Mock"},
      {key: "ChargePointModel", readonly: true, value: "Simulator"},
      {key: "ChargeBoxSerialNumber", readonly: true, value: "SN0000000000000001"},
    ]
  }

  public async start() {
    if (this.config.chargePointPort) {
      await createChargePointServer(this.chargePoint, this.config.chargePointPort)
      log.info(
        `Started SOAP Charge Point server at http://localhost:${this.config.chargePointPort}/`
      )

      this.centralSystem = await createCentralSystemClient(
        this.config.centralSystemEndpoint,
        this.config.chargerIdentity,
        `http://localhost:${this.config.chargePointPort}/`
      )
      log.info(`Will send messages to Central System at ${this.config.centralSystemEndpoint}`)
    } else {
      const {remote} = await createRpcClient(
        async () => {
          ws = new WebSocket(
            this.config.centralSystemEndpoint + "/" + this.config.chargerIdentity,
            "ocpp1.6"
          )

          return wrapWebsocket(ws)
        },
        {
          local: this.chargePoint,
          reconnect: true,
          keepAliveTimeout: this.config.keepAliveTimeoutMs,

          listeners: {
            messageIn: (data) => {
              log.debug("OCPP in", data)
            },
            messageOut: (data) => {
              log.debug("OCPP out", data)
            },
            connected() {
              log.debug("OCPP connected")
            },
            disconnected({code, reason}) {
              log.debug("OCPP disconnected", {code, reason})
            },
            subscribed(subscriptions: number): void {},
            unsubscribed(subscriptions: number): void {},
          },
        }
      )

      log.info(
        `Connected to Central System at ${this.config.centralSystemEndpoint} using WebSocket`
      )

      this.centralSystem = remote
    }

    if (this.config.defaultHeartbeatIntervalSec) {
      setInterval(() => {
        this.centralSystem.Heartbeat()
      }, this.config.defaultHeartbeatIntervalSec * 1000)
    }
  }

  public startTransaction({connectorId, idTag}, delay) {
    if (this.meterTimer) {
      return false
    }

    setTimeout(
      async () => {
        this.transactionId = (
          await this.centralSystem.StartTransaction({
            connectorId,
            idTag,
            timestamp: new Date(),
            meterStart: 0,
          })
        ).transactionId

        this.charged = 0

        this.meterTimer = setInterval(() => {
          this.charged += Math.random() > 0.5 ? Math.random() > 0.5 ? 400 : 300 :  Math.random() ? 200 : 500

          this.centralSystem.MeterValues({
            connectorId,
            transactionId: this.transactionId,
            meterValue: [
              {
                timestamp: new Date(),
                sampledValue: [
                  {
                    value: "" + this.charged,
                    measurand: "Energy.Active.Import.Register",
                    unit: "Wh",
                  },
                  {
                    value: "38",
                    measurand: "SoC",
                    unit: "Percent",
                  },
                  {
                    value: "" + (Math.random() * (1 - 2) + 1)*150,
                    measurand: "Power.Active.Import",
                    unit: "W",
                  },
                  {
                    value: "" + (Math.random() * (1 - 2) + 1),
                    measurand: "Current.Import",
                    unit: "A",
                    phase: "L1"
                  },
                ],
              },
            ],
          })
        }, this.config.meterValuesIntervalSec * 1000)
      },
      delay ? this.config.startDelayMs : 1000
    )

    return true
  }

  public printConf() {
    console.log(JSON.stringify(this.configurationKeys));

    return true
  }

  public stopTransaction(params, delay) {
    if (!this.meterTimer) {
      return false
    }

    clearInterval(this.meterTimer)

    setTimeout(
      async () => {
        await this.centralSystem.StopTransaction({
          ...params,
          timestamp: new Date(),
          meterStop: this.charged,
        })

        this.meterTimer = null
        this.transactionId = null
      },
      delay ? this.config.stopDelayMs : 0
    )

    return true
  }

  disconnect() {
    ws.close()
  }

  public centralSystem = null

  private config: Config = null
  private meterTimer = null
  private charged = 0
  private configurationKeys = []
  private transactionId = null
  private chargePoint = {
    RemoteStartTransaction: async (req) => {
      return {
        status: this.startTransaction(req, true) ? "Accepted" : "Rejected",
        // status: "Rejected",
      }
    },

    RemoteStopTransaction: async (req) => {
      this.stopTransaction(req, false)
      this.centralSystem.StatusNotification({
        connectorId: 1,
        errorCode: "NoError",
        status: "Finishing",
      });
      return {
        status: "Accepted",
      }
    },

    UnlockConnector: async (req) => {
      return {
        status: "Accepted",
      }
    },

    GetConfiguration: async (req) => {
      await new Promise((r) => setTimeout(r, 2000))

      return {configurationKey: this.configurationKeys}
    },
    ChangeConfiguration: async (req) => {
      for (let i = 0; i < this.configurationKeys.length; i++) {
        // if (this.configurationKeys[i].key == req.key) {
          this.configurationKeys[i].value = "" + req.value
        // }
      }

      return {status: "Accepted"}
    },

    ChangeAvailability: async(req) => {
      return {status: "Accepted"}
    },

    ClearCache: async(req) => {
      return {status: "Accepted"}
    },

    ReserveNow: async (req) => {
      return {status: "Accepted"}
    },

    CancelReservation: async (req) => {
      return {status: "Accepted"}
    },

    Reset: async (req) => {
      return {status: "Accepted"}
    },

    TriggerMessage: async (req) => {
      this.centralSystem.MeterValues({
        connectorId: 1,
        transactionId: this.transactionId,
        meterValue: [
          {
            timestamp: new Date(),
            sampledValue: [
              {
                value: "" + this.charged,
                measurand: "Energy.Active.Import.Register",
                unit: "Wh",
              },
              {
                value: "38",
                measurand: "SoC",
                unit: "Percent",
              },
              {
                value: "" + (Math.random() * (1 - 2) + 1)*150,
                measurand: "Power.Active.Import",
                unit: "W",
              },
              {
                value: "" + (Math.random() * (1 - 2) + 1),
                measurand: "Current.Import",
                unit: "A",
                phase: "L1"
              },
            ],
          },
        ],
      });
      return {status: "Accepted"}
    },

    UpdateFirmware: async (req) => {
      return {status: "Accepted"}
    },

    SendLocalList: async (req) => {
      for (let i = 0; i < this.configurationKeys.length; i++) {
        if (this.configurationKeys[i].key == "localAuthorizationList") {
          // console.log(req);
          this.configurationKeys[i].value = req.localAuthorizationList
        }
      }
      return {status: "Accepted"}
    }
  }
}
