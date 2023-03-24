import { StatusBar } from 'expo-status-bar'
import {
  ActivityIndicator,
  Button,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
  PermissionsAndroid
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Battery from 'expo-battery'
import BackgroundService from 'react-native-background-actions'
import { useEffect, useRef, useState } from 'react'
import dgram from 'react-native-udp'

export default function App() {
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const [config, setConfig] = useState({
    serverIP: '',
    negotiator: '',
    servicePort: ''
  })
  const logsRef = useRef()

  useEffect(() => {
    ;(async () => {
      const enabled = await Battery.isBatteryOptimizationEnabledAsync()
      if (enabled) log('Please disable battery optimization')
      else log('Battery optimization disabled')
      await loadConfig()
    })()
  }, [])

  async function loadConfig() {
    try {
      const res = await AsyncStorage.getItem('@sneakytunnelstoragekey')
      if (res !== null) {
        const data = JSON.parse(res)
        setConfig(oldConfig => ({ ...oldConfig, ...data }))
      }
      log('Config loaded')
    } catch (e) {
      log(e.message)
    }
  }

  async function startTunnel() {
    try {
      // declare global vars
      const connectionToService = dgram.createSocket({ type: 'udp4', debug: true })
      let userIP = null
      let userPort = null
      let clientPort = null
      let serverPort = null

      // get public ip
      const publicIP = await (await fetch('https://api.ipify.org')).text()
      log(publicIP)

      // test negotiator
      console.log(config.negotiator)
      let res = await fetch(config.negotiator, { method: 'HEAD' })
      if (res.status === 200) {
        log('negotiator ok')
      } else {
        log('negotiator not ok')
        return
      }

      // open port and negotiate
      const connectionToServer = dgram.createSocket({
        type: 'udp4',
        debug: true
      })
      connectionToServer.bind(randomPort())
      connectionToServer.once('listening', () => {
        clientPort = connectionToServer.address().port
        log('client port selected: ' + clientPort)
      })
      while (clientPort === null) {
        await sleep(50)
      }
      res = await fetch(`${config.negotiator}/${config.serverIP}/${publicIP}:${clientPort}`)
      if (res.status === 200) {
        serverPort = await res.text()
        log('negotiated server port: ' + serverPort)
      } else {
        log('could not negotatie server port')
        return
      }

      // send dummy packet
      const dummyPacket = new Uint8Array(2)
      dummyPacket[0] = 1
      dummyPacket[1] = 0
      connectionToServer.send(dummyPacket, undefined, undefined, Number(serverPort), config.serverIP, err => {
        if (err) {
          log('error sending dummy packet: ' + err.message)
          throw err
        }
      })

      // listen for packets from server
      connectionToServer.on('message', (data, remoteInfo) => {
        if (remoteInfo.address !== config.serverIP) return
        if (data[0] > 0) {
          if (data[0] === 1) {
            const portBytes = stringToUint8Array(config.servicePort)
            const announcementPacket = new Uint8Array(4)
            announcementPacket[0] = 4
            announcementPacket[1] = 0
            announcementPacket[2] = portBytes[0]
            announcementPacket[3] = portBytes[1]
            connectionToServer.send(
              announcementPacket,
              undefined,
              undefined,
              remoteInfo.port,
              remoteInfo.address,
              err => {
                if (err) log('error sending announcement packet: ' + err.message)
                else {
                  log('sent announcement packet to server')
                  setStatus('connected')
                }
              }
            )
            return
          } else if (data[0] === 2) {
            // keep-alive packet
            return
          }
        }
        connectionToService.send(data.slice(2), undefined, undefined, userPort, userIP, err => {
          if (err) log('error sending data packet to service' + err.message)
        })
      })

      // ask for dummy packet
      await sleep(3000)
      res = await fetch(`${config.negotiator}/${config.serverIP}/${publicIP}:${clientPort}`, { method: 'POST' })
      if (res.status !== 200) {
        log('Failed to ask for dummy packet with status: ' + res.status)
        return
      }

      // listen for packets from service
      connectionToService.bind(Number(servicePort))
      const port = Number(serverPort) // to avoid reading config
      const ip = config.serverIP // to avoid reading config
      connectionToService.on('message', (data, remoteInfo) => {
        userIP = remoteInfo.address
        userPort = remoteInfo.port
        connectionToServer.send([0, 0, ...data], undefined, undefined, port, ip, err => {
          if (err) log('error sending data packet to server' + err.message)
        })
      })

      while (true) await sleep(10000)
    } catch (error) {
      log(error.message)
    } finally {
      log('Service finished')
      setStatus('disconnected')
    }
  }

  async function connectButtonHandler() {
    try {
      if (status === 'connected') {
        await BackgroundService.stop()
        log('disconnected')
        setStatus('disconnected')
      } else {
        setStatus('connecting')
        await AsyncStorage.setItem('@sneakytunnelstoragekey', JSON.stringify(config))
        log('Saved config')
        await BackgroundService.start(startTunnel, {
          taskName: 'Sneaky Tunnel',
          taskTitle: 'Sneaky Tunnel',
          taskDesc: 'Sneaky Tunnel Service Started',
          taskIcon: {
            name: 'ic_launcher',
            type: 'mipmap'
          },
          color: '#ff00ff',
          linkingURI: 'yourSchemeHere://chat/jane',
          parameters: {}
        })
      }
    } catch (error) {
      console.log(error)
    }
  }

  async function log(message) {
    setLogs(oldLogs => [
      ...oldLogs,
      {
        title: `[${new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })}] ${message}`
      }
    ])
    setTimeout(() => logsRef.current?.scrollToEnd(), 200)
  }

  function sleep(time) {
    return new Promise(resolve => setTimeout(() => resolve(), time))
  }

  function randomPort() {
    return (Math.random() * 60536) | (0 + 5000)
  }

  function stringToUint8Array(str) {
    const number = Number(str)
    let bits = number.toString(2)
    const bitsArray = bits.split('')
    while (bitsArray.length < 16) bitsArray.unshift('0')
    bits = bitsArray.join('')
    const firstByte = bits.slice(8)
    const secondByte = bits.slice(0, 8)
    const uint8Array = new Uint8Array(2)
    uint8Array[0] = parseInt(firstByte, 2)
    uint8Array[1] = parseInt(secondByte, 2)
    return uint8Array
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.inputsContainer}>
        <View style={styles.innerInputsContainer}>
          <TextInput
            style={{ ...styles.input, width: '60%' }}
            placeholder="Server IP"
            value={config.serverIP}
            onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, serverIP: t }))}
          ></TextInput>
          <TextInput
            style={{ ...styles.input, width: '35%' }}
            placeholder="Service Port"
            value={config.servicePort}
            onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, servicePort: t }))}
          ></TextInput>
        </View>
        <TextInput
          style={styles.input}
          placeholder="Negotiator"
          value={config.negotiator}
          onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, negotiator: t }))}
        ></TextInput>
      </View>
      <Text
        style={{
          ...styles.statusText,
          letterSpacing: 2,
          color: status === 'connected' ? 'green' : 'disconnected' ? 'red' : 'orange'
        }}
      >
        {status.toUpperCase()}
      </Text>
      <FlatList
        scrollEnabled={false}
        ref={logsRef}
        data={logs}
        renderItem={({ item }) => <Text style={{ color: 'white' }}>{item.title}</Text>}
        style={{
          backgroundColor: '#555',
          marginBottom: 16,
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingTop: 8
        }}
        ListFooterComponent={<View style={{ paddingBottom: 8 }} />}
      />
      {status === 'connected' || status === 'disconnected' ? (
        <View style={styles.connectButtonContainer}>
          <Button title={status === 'connected' ? 'disconnect' : 'connect'} onPress={connectButtonHandler}></Button>
        </View>
      ) : (
        <ActivityIndicator size={32}></ActivityIndicator>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingVertical: 16,
    paddingHorizontal: 8,
    backgroundColor: '#222'
  },
  inputsContainer: {
    marginBottom: 16
  },
  innerInputsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16
  },
  input: {
    backgroundColor: '#555',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    color: 'white'
  },
  connectButtonContainer: {
    justifyContent: 'center',
    alignItems: 'center'
  },
  statusText: {
    marginBottom: 16,
    fontSize: 20,
    textAlign: 'center',
    fontWeight: 'bold'
  }
})
