import { Tabs } from 'expo-router'

// V2 accent — Forest (DAM default). Will match active airport globally when airport state is lifted.
const ACTIVE_TINT = '#054239'
const MUTED_TINT  = '#8A8578'

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(255,255,255,0.96)',
          borderTopColor: '#D8D3BF',
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: ACTIVE_TINT,
        tabBarInactiveTintColor: MUTED_TINT,
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Flights',
          tabBarIcon: ({ color }) => <TabIcon emoji="✈️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: 'Track',
          tabBarIcon: ({ color }) => <TabIcon emoji="🗺️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="destinations"
        options={{
          title: 'Destinations',
          tabBarIcon: ({ color }) => <TabIcon emoji="🏙️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="airlines"
        options={{
          title: 'Airlines',
          tabBarIcon: ({ color }) => <TabIcon emoji="🛫" color={color} />,
        }}
      />
    </Tabs>
  )
}

function TabIcon({ emoji, color }: { emoji: string; color: string }) {
  const { Text } = require('react-native')
  return <Text style={{ fontSize: 18, opacity: color === ACTIVE_TINT ? 1 : 0.4 }}>{emoji}</Text>
}
