import { StatusBar } from 'expo-status-bar'
import { Button, StyleSheet, Text, TextInput, View, ToastAndroid, Alert } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Battery from 'expo-battery'
import BackgroundService from 'react-native-background-actions'
import { useEffect, useState } from 'react'
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
  const [status, setStatus] = useState('Disconnected')
  const [statusMessage, setStatusMessage] = useState('')
  const [config, setConfig] = useState({
    serverIP: '',
    negotiator: '',
    servicePort: ''
  })

  useEffect(() => {
    initApp()
  }, [])

  async function initApp() {
    try {
      // get battery optimization status
      const enabled = await Battery.isBatteryOptimizationEnabledAsync()
      if (enabled) {
        // alert user to disable battery optimizaion
        Alert.alert(
          'Battery Optimization Warning',
          'Please disable battery optimizations or allow background activity.',
          [{ text: 'OK' }]
        )
      } else setStatusMessage('Battery optimization disabled')

      // load config from local storage
      const res = await AsyncStorage.getItem('@sneakytunnelstoragekey')
      if (res !== null) {
        const data = JSON.parse(res)
        setConfig(oldConfig => ({ ...oldConfig, ...data }))
      }
      setStatusMessage('Config loaded')
    } catch (error) {
      setStatusMessage(error.message)
      console.log(error)
    }
  }

  async function startTunnel() {
    try {
      // declare vars
      const connectionToService = dgram.createSocket({ type: 'udp4' })
      const connectionToServer = dgram.createSocket({ type: 'udp4' })
      let userIP = null
      let userPort = null
      let clientPort = null
      let serverPort = null
      const serverIP = config.serverIP
      let lastReceivedPacket = null

      // test negotiator
      setStatus('Testing Negotiator')
      let res = await fetch(config.negotiator, { method: 'HEAD' })
      if (res.status === 200) {
        setStatusMessage('Negotiator ok')
      } else {
        setStatusMessage('Negotiator not ok')
        return
      }

      // open port and negotiate
      setStatus('Opening New Port')
      connectionToServer.bind(randomPort())
      connectionToServer.once('listening', () => {
        clientPort = connectionToServer.address().port
        setStatusMessage(`Opened port ${clientPort}`)
      })
      while (clientPort === null) {
        await sleep(50)
      }
      setStatus("Getting Server's Port")
      res = await fetch(`${config.negotiator}/${serverIP}/${clientPort}`)
      if (res.status === 200) {
        serverPort = await res.text()
        serverPort = Number(serverPort)
        setStatusMessage(`Negotiated port ${serverPort}`)
      } else {
        setStatusMessage("Could not get server's port")
        return
      }

      // send dummy packet
      setStatus('Sending Dummy Packet')
      connectionToServer.send([1, 0], undefined, undefined, serverPort, serverIP, err => {
        if (err) {
          setStatusMessage('Failed to sending dummy packet: ' + err.message)
          BackgroundService.stop()
        } else setStatusMessage('Sent dummy packet to server')
      })

      // listen for packets from server
      connectionToServer.on('message', (data, remoteInfo) => {
        // set last received packet timestamp
        lastReceivedPacket = Date.now()

        // check for flags
        if (data[0] > 0) {
          if (data[0] == 1) {
            setStatusMessage('Received dummy packet from server')
            setStatus('Connected')
          } else if (data[0] == 2) {
            connectionToServer.send([5, 0], undefined, undefined, serverPort, serverIP, err => {
              if (err) setStatusMessage('Failed to send keep-alive response to server')
            })
          }
          return
        }

        // forward packet to service
        connectionToService.send(data, 2, remoteInfo.size, userPort, userIP, err => {
          if (err) setStatusMessage('Error sending data packet to service' + err.message)
        })
      })

      // ask for dummy packet from server
      setStatus('Requesting Dummy Packet')
      res = await fetch(`${config.negotiator}/${serverIP}/${clientPort}`, { method: 'POST' })
      if (res.status !== 200) {
        setStatusMessage('Failed to ask for dummy packet with status: ' + res.status)
        return
      }

      // bind service connection
      connectionToService.bind(Number(config.servicePort))

      // set up on time listener to receive first packet from service
      connectionToService.once('message', (data, remoteInfo) => {
        // send announcement packet to server
        connectionToServer.send(
          [4, 0, ...stringToUint8Array(config.servicePort)],
          undefined,
          undefined,
          serverPort,
          serverIP,
          err => {
            if (err) {
              setStatusMessage('Error sending announcement packet: ' + err.message)
              BackgroundService.stop()
            } else {
              setStatusMessage('Sent announcement packet to server')
              setStatus('Connected')
            }
          }
        )
        // store user's ip and port
        userIP = remoteInfo.address
        userPort = remoteInfo.port

        // forward first packet to server
        connectionToServer.send([0, 0, ...data], undefined, undefined, serverPort, serverIP, err => {
          if (err) {
            setStatusMessage('Error sending first data packet to server' + err.message)
            BackgroundService.stop()
          }
        })

        // listen for the rest of the packets from service and forward them to server
        connectionToService.on('message', data =>
          connectionToServer.send([0, 0, ...data], undefined, undefined, serverPort, serverIP)
        )
      })

      // listen for errors
      connectionToServer.on('error', err => {
        setStatus('Discconected')
        setStatusMessage(err.message)
        BackgroundService.stop()
      })

      // check to see if still connected to server every 15 seconds
      while (true) {
        if (lastReceivedPacket !== null && Date.now() - lastReceivedPacket > 15000) {
          setStatus('Disconnected')
          showToast('Sneaky Tunnel Disconnected')
          setStatusMessage('Did not receive keep-alive packet in time')
          await BackgroundService.stop()
        }
        await sleep(15000)
      }
    } catch (error) {
      setStatusMessage(error.message)
    } finally {
      setStatus('Disconnected')
      showToast('Sneaky Tunnel Disconnected')
      if (BackgroundService.isRunning()) BackgroundService.stop()
    }
  }

  async function connectButtonHandler() {
    try {
      if (status == 'Connected') {
        await BackgroundService.stop()
        setStatus('Disconnected')
      } else {
        setStatus('Connecting')

        // save config to local storage
        await AsyncStorage.setItem('@sneakytunnelstoragekey', JSON.stringify(config))
        setStatusMessage('Saved config')

        // start tunnel as a background service
        await BackgroundService.start(startTunnel, {
          taskName: 'Sneaky Tunnel',
          taskTitle: 'Sneaky Tunnel',
          taskDesc: 'Sneaky Tunnel Service Started',
          taskIcon: { name: 'ic_launcher', type: 'mipmap' },
          color: '#ff00ff',
          linkingURI: 'yourSchemeHere://chat/jane'
        })
      }
    } catch (error) {
      setStatusMessage(error.message)
      console.log(error)
    }
  }

  return (
    <SafeAreaView
      style={{
        flex: 1,
        paddingVertical: 16,
        paddingHorizontal: 8,
        backgroundColor: '#222',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}
    >
      <StatusBar style="light" />
      <View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
          <TextInput
            style={{ ...styles.input, width: '60%' }}
            placeholder="Server IP"
            value={config.serverIP}
            onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, serverIP: t }))}
            keyboardType="numeric"
          ></TextInput>
          <TextInput
            style={{ ...styles.input, width: '35%' }}
            placeholder="Service Port"
            value={config.servicePort}
            onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, servicePort: t }))}
            keyboardType="numeric"
          ></TextInput>
        </View>
        <TextInput
          style={styles.input}
          placeholder="Negotiator"
          value={config.negotiator}
          onChangeText={t => setConfig(oldConfig => ({ ...oldConfig, negotiator: t }))}
        ></TextInput>
      </View>
      <View>
        <Text
          style={{
            marginBottom: 16,
            fontSize: 20,
            textAlign: 'center',
            fontWeight: 'bold',
            letterSpacing: 2,
            color: status === 'Connected' ? 'green' : status === 'Disconnected' ? 'red' : 'orange'
          }}
        >
          {status}
        </Text>
        <Text style={{ color: '#aaa', fontSize: 12, fontWeight: 'bold' }}>{statusMessage}</Text>
      </View>
      <Button
        disabled={status != 'Connected' && status != 'Disconnected'}
        title={status === 'Connected' ? 'disconnect' : 'connect'}
        onPress={connectButtonHandler}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: '#555',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    color: 'white'
  }
})
