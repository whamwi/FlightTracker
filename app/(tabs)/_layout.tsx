import { Tabs } from 'expo-router'
import Svg, { Path, G } from 'react-native-svg'

const ACTIVE   = '#054239'   // Forest — DAM accent
const INACTIVE = '#8A8578'   // Ink muted

function TrackIcon({ color }: { color: string }) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.85} strokeLinecap="round" strokeLinejoin="round">
      <G transform="translate(1.6 -1) scale(0.86)">
        <Path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
      </G>
      <Path d="M2.2 21.6c1.6-1.7 3.4-3.2 5.5-4.4" strokeDasharray="2.3 2.5" />
    </Svg>
  )
}

function FlightsIcon({ color }: { color: string }) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.85} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M2 22h20" />
      <Path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.7.35 1.7-3.4 1.9-.95a2 2 0 0 1 1.8 0l.7.35" />
      <Path d="m14.5 12.5 2.5-5.5a2 2 0 0 1 1.5-1.1l2.9-.5a1 1 0 0 1 1.1 1.3l-1.1 3a2 2 0 0 1-1.1 1.2L6.4 17.4" />
    </Svg>
  )
}

function DestinationsIcon({ color }: { color: string }) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.85} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 22V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v18" />
      <Path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <Path d="M16 9h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
      <Path d="M10 6.5h2M10 10.5h2M10 14.5h2M10 18.5h2" />
    </Svg>
  )
}

function AirlinesIcon({ color }: { color: string }) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.85} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M2 9a3 3 0 0 0 0 6v2.5A1.5 1.5 0 0 0 3.5 19h17a1.5 1.5 0 0 0 1.5-1.5V15a3 3 0 0 1 0-6V6.5A1.5 1.5 0 0 0 20.5 5h-17A1.5 1.5 0 0 0 2 6.5z" />
      <Path d="M13.5 5v14" strokeDasharray="2.2 2.4" />
    </Svg>
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
        tabBarActiveTintColor:      ACTIVE,
        tabBarInactiveTintColor:    INACTIVE,
        tabBarActiveLabelStyle:     { fontSize: 10.5, fontWeight: '700' },
        tabBarInactiveLabelStyle:   { fontSize: 10.5, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="map"
        options={{
          title: 'Track',
          tabBarIcon: ({ focused }) => <TrackIcon color={focused ? ACTIVE : INACTIVE} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Flights',
          tabBarIcon: ({ focused }) => <FlightsIcon color={focused ? ACTIVE : INACTIVE} />,
        }}
      />
      <Tabs.Screen
        name="destinations"
        options={{
          title: 'Destinations',
          tabBarIcon: ({ focused }) => <DestinationsIcon color={focused ? ACTIVE : INACTIVE} />,
        }}
      />
      <Tabs.Screen
        name="airlines"
        options={{
          title: 'Airlines',
          tabBarIcon: ({ focused }) => <AirlinesIcon color={focused ? ACTIVE : INACTIVE} />,
        }}
      />
    </Tabs>
  )
}
