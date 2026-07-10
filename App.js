import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable, useWindowDimensions } from 'react-native';

export default function App() {
  const [bpm, setBpm] = useState(120);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(1);
  const intervalRef = useRef(null);
  const holdRef = useRef(null);

  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const change = (delta) => {
    setBpm((prev) => Math.min(300, Math.max(30, prev + delta)));
  };

  const startHold = (delta) => {
    change(delta);
    let count = 0;
    const tick = () => {
      count += 1;
      change(delta);
      // Nach längerem Halten schneller wiederholen
      const delay = count > 15 ? 30 : count > 6 ? 70 : 150;
      holdRef.current = setTimeout(tick, delay);
    };
    holdRef.current = setTimeout(tick, 400);
  };

  const stopHold = () => {
    if (holdRef.current) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  const toggle = () => {
    setRunning((prev) => !prev);
  };

  useEffect(() => () => stopHold(), []);

  useEffect(() => {
    if (running) {
      setBeat(1);
      const ms = 60000 / bpm;
      intervalRef.current = setInterval(() => {
        setBeat((prev) => (prev % 4) + 1);
      }, ms);
    } else {
      setBeat(1);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, bpm]);

  return (
    <View style={[styles.container, landscape && styles.containerLandscape]}>
      <Pressable style={styles.display} onPress={toggle}>
        <Text style={styles.beat}>{beat}</Text>
        <Text style={styles.hint}>{running ? 'Tippen zum Stoppen' : 'Tippen zum Starten'}</Text>
      </Pressable>

      <View
        style={[
          styles.controls,
          landscape ? styles.controlsLandscape : styles.controlsPortrait,
        ]}
      >
        <Pressable
          style={styles.button}
          onPressIn={() => startHold(landscape ? 1 : -1)}
          onPressOut={stopHold}
        >
          <Text style={styles.buttonText}>{landscape ? '+' : '-'}</Text>
        </Pressable>

        <View style={styles.tempoBox}>
          <Text style={styles.tempo}>{bpm}</Text>
          <Text style={styles.unit}>BPM</Text>
        </View>

        <Pressable
          style={styles.button}
          onPressIn={() => startHold(landscape ? -1 : 1)}
          onPressOut={stopHold}
        >
          <Text style={styles.buttonText}>{landscape ? '-' : '+'}</Text>
        </Pressable>
      </View>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    flexDirection: 'column',
  },
  containerLandscape: {
    flexDirection: 'row',
  },
  display: {
    flex: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  beat: {
    fontSize: 160,
    fontWeight: 'bold',
  },
  hint: {
    fontSize: 16,
    color: '#888',
    marginTop: 10,
  },
  controls: {
    flex: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsPortrait: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  controlsLandscape: {
    flexDirection: 'column',
    borderLeftWidth: 1,
    borderLeftColor: '#eee',
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    margin: 20,
  },
  buttonText: {
    color: '#fff',
    fontSize: 40,
  },
  tempoBox: {
    alignItems: 'center',
    minWidth: 90,
  },
  tempo: {
    fontSize: 44,
    fontWeight: 'bold',
  },
  unit: {
    fontSize: 16,
    color: '#888',
  },
});
