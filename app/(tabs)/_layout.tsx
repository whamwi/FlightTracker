import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

// V2 Forest accent for DAM (default) active state
const ACTIVE   = '#054239'
const INACTIVE = '#8A8578'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function TabIcon({
  name,
  nameOutline,
  focused,
}: {
  name: IoniconsName
  nameOutline: IoniconsName
  focused: boolean
}) {
  return (
    <Ionicons
      name={focused ? name : nameOutline}
      size={22}
      color={focused ? ACTIVE : INACTIVE}
    />
  )
}

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
        tabBarActiveTintColor:   ACTIVE,
        tabBarInactiveTintColor: INACTIVE,
        tabBarLabelStyle: { fontSize: 10.5 },
      }}
    >
      {/* Design order: Track · Flights · Destinations · Airlines */}
      <Tabs.Screen
        name="map"
        options={{
          title: 'Track',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="navigate" nameOutline="navigate-outline" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Flights',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="airplane" nameOutline="airplane-outline" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="destinations"
        options={{
          title: 'Destinations',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="business" nameOutline="business-outline" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="airlines"
        options={{
          title: 'Airlines',
          tabBarIcon: ({ focused }) => (
            <TabIcon name="ticket" nameOutline="ticket-outline" focused={focused} />
          ),
        }}
      />
    </Tabs>
  )
}
