import { View, Text, SafeAreaView } from 'react-native'

export default function AirlinesScreen() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#253548' }}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontSize: 32 }}>🛫</Text>
        <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>Airlines</Text>
        <Text style={{ color: '#4b5563', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 }}>
          Airlines page coming soon
        </Text>
      </View>
    </SafeAreaView>
  )
}
