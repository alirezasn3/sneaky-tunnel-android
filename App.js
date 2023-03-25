import { StatusBar } from 'expo-status-bar'
import { ActivityIndicator, Button, FlatList, StyleSheet, Text, TextInput, View, ToastAndroid } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Battery from 'expo-battery'
import BackgroundService from 'react-native-background-actions'
import { useEffect, useRef, useState } from 'react'
import dgram from 'react-native-udp'

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

function showToast(message) {
  ToastAndroid.show(message, ToastAndroid.LONG)
}

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
      const connectionToService = dgram.createSocket({ type: 'udp4' })
      const connectionToServer = dgram.createSocket({ type: 'udp4' })
      let userIP = null
      let userPort = null
      let clientPort = null
      let serverPort = null
      let announced = false
      const serverIP = config.serverIP
      let lastReceivedPacket = null
      let shouldClose = false

      // get public ip
      const publicIP = await (await fetch('https://api.ipify.org')).text()
      log(publicIP)

      // test negotiator
      let res = await fetch(config.negotiator, { method: 'HEAD' })
      if (res.status === 200) {
        log('negotiator ok')
      } else {
        log('negotiator not ok')
        return
      }

      // open port and negotiate
      connectionToServer.bind(randomPort())
      connectionToServer.once('listening', () => {
        clientPort = connectionToServer.address().port
        log('client port selected: ' + clientPort)
      })
      while (clientPort === null) {
        await sleep(50)
      }
      res = await fetch(`${config.negotiator}/${serverIP}/${publicIP}:${clientPort}`)
      if (res.status === 200) {
        serverPort = await res.text()
        serverPort = Number(serverPort)
        log('negotiated server port: ' + serverPort)
      } else {
        log('could not negotatie server port')
        return
      }

      // send dummy packet
      const dummyPacket = new Uint8Array(2)
      dummyPacket[0] = 1
      dummyPacket[1] = 0
      connectionToServer.send(dummyPacket, undefined, undefined, Number(serverPort), serverIP, err => {
        if (err) log('error sending dummy packet: ' + err.message)
        else log('sent dummy packet to server')
      })

      // listen for packets from server
      connectionToServer.on('message', (data, remoteInfo) => {
        if (remoteInfo.address !== serverIP) return
        if (data[0] > 0) {
          if (data[0] === 1) {
            log('received dummy packet from server')
            setStatus('connected')
          } else if (data[0] === 2) {
            lastReceivedPacket = Date.now()
            connectionToServer.send([5, 0], undefined, undefined, serverPort, serverIP, err => {
              if (err) log('failed to send keep-alive response to server')
            })
          }
          return
        }
        connectionToService.send(data.slice(2), undefined, undefined, userPort, userIP, err => {
          if (err) log('error sending data packet to service' + err.message)
        })
      })

      // ask for dummy packet
      await sleep(3000)
      res = await fetch(`${config.negotiator}/${serverIP}/${publicIP}:${clientPort}`, { method: 'POST' })
      if (res.status !== 200) {
        log('Failed to ask for dummy packet with status: ' + res.status)
        return
      }

      // listen for packets from service
      connectionToService.bind(Number(config.servicePort))
      connectionToService.on('message', (data, remoteInfo) => {
        if (!announced) {
          const portBytes = stringToUint8Array(config.servicePort)
          const announcementPacket = new Uint8Array(4)
          announcementPacket[0] = 4
          announcementPacket[1] = 0
          announcementPacket[2] = portBytes[0]
          announcementPacket[3] = portBytes[1]
          connectionToServer.send(announcementPacket, undefined, undefined, serverPort, serverIP, err => {
            if (err) log('error sending announcement packet: ' + err.message)
            else {
              log('sent announcement packet to server')
              setStatus('connected')
              announced = true
            }
          })
          userIP = remoteInfo.address
          userPort = remoteInfo.port
        }
        connectionToServer.send([0, 0, ...data], undefined, undefined, serverPort, serverIP, err => {
          if (err) log('error sending data packet to server' + err.message)
        })
      })

      while (!shouldClose) {
        if (lastReceivedPacket !== null && Date.now() - lastReceivedPacket > 15000) {
          shouldClose = true
          setStatus('disconnected')
          showToast('Sneaky Tunnel Disconnected')
          log('did not receive keep-alive packet in time')
        }
        await sleep(15000)
      }
    } catch (error) {
      log(error.message)
    } finally {
      setStatus('disconnected')
      showToast('Sneaky Tunnel Disconnected')
      log('service exited')
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
    setTimeout(() => logsRef.current?.scrollToEnd())
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
          color: status === 'connected' ? 'green' : status === 'disconnected' ? 'red' : 'orange'
        }}
      >
        {status.toUpperCase()}
      </Text>
      <FlatList
        scrollEnabled={false}
        ref={logsRef}
        data={logs}
        renderItem={({ item, index }) => (
          <Text style={{ color: 'white', marginBottom: index === logs.length - 1 ? 8 : 0 }}>{item.title}</Text>
        )}
        style={{
          backgroundColor: '#555',
          marginBottom: 16,
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingTop: 8,
          marginBottom: 8
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
    alignItems: 'center',
    marginTop: 8
  },
  statusText: {
    marginBottom: 16,
    fontSize: 20,
    textAlign: 'center',
    fontWeight: 'bold'
  }
})
