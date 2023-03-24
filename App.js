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
      await requestNotificationPermission()
      await loadConfig()
    })()
  }, [])

  const requestNotificationPermission = async () => {
    try {
      let granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
        title: 'Sneaky Tunnel Notification Access',
        message: 'Sneaky Tunnel needs access to post notifications.',
        buttonNeutral: 'Ask Me Later',
        buttonNegative: 'Cancel',
        buttonPositive: 'Allow'
      })
      if (granted === PermissionsAndroid.RESULTS.GRANTED) log('Notification permission granted')
      else log('Notification permission denied')
    } catch (err) {
      console.warn(err)
    }
  }

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
      const connectionToService = dgram.createSocket({
        type: 'udp4',
        debug: true
      })
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
            const announcementPacket = new Uint8Array(2)
            announcementPacket[0] = 4
            announcementPacket[1] = 0
            connectionToServer.send(
              announcementPacket,
              undefined,
              undefined,
              remoteInfo.port,
              remoteInfo.address,
              err => {
                if (err) {
                  log('error sending announcement packet: ' + err.message)
                  throw err
                } else {
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
          if (err) {
            log('error sending data packet to service' + err.message)
            throw err
          }
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
      connectionToService.bind(1194)
      connectionToService.on('message', (data, remoteInfo) => {
        userIP = remoteInfo.address
        userPort = remoteInfo.port
        connectionToServer.send([0, 0, ...data], undefined, undefined, Number(serverPort), config.serverIP, err => {
          if (err) {
            log('error sending data packet to server' + err.message)
            console.log(err)
          }
        })
      })

      while (true) {
        await sleep(5000)
      }
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
        await BackgroundService.start(
          async taskDataArguments => {
            try {
              await startTunnel()
            } catch (error) {
              log(error.message)
            }
          },
          {
            taskName: 'Sneaky Tunnel',
            taskTitle: 'Connecting',
            taskDesc: 'Connecting to remote server',
            taskIcon: {
              name: 'ic_launcher',
              type: 'mipmap'
            },
            color: '#ff00ff',
            linkingURI: 'yourSchemeHere://chat/jane', // See Deep Linking for more info
            parameters: {}
          }
        )
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
    logsRef.current?.scrollToEnd()
    if (BackgroundService.isRunning()) {
      await BackgroundService.updateNotification({
        taskDesc: message
      })
    }
  }

  function sleep(time) {
    return new Promise(resolve => setTimeout(() => resolve(), time))
  }

  function randomPort() {
    return (Math.random() * 60536) | (0 + 5000) // 60536-65536
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
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
      <Text style={styles.statusText}>{status}</Text>
      <FlatList
        scrollEnabled={false}
        ref={logsRef}
        data={logs}
        renderItem={({ item }) => <Text>{item.title}</Text>}
        style={{
          backgroundColor: '#eee',
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
    paddingHorizontal: 8
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
    backgroundColor: '#eee',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8
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
