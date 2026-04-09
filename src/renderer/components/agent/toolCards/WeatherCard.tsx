/**
 * Rich weather result card — renders when agent calls a weather tool.
 * Inspired by AG-UI Dojo backend_tool_rendering demo.
 */

import React from 'react';
import { Sun, CloudyNight, HeavyRain } from '@icon-park/react';
import type { ToolCardProps } from '.';

function getConditionIcon(conditions: string) {
  const c = (conditions || '').toLowerCase();
  if (c.includes('rain') || c.includes('storm') || c.includes('drizzle')) {
    return <HeavyRain theme='filled' size='36' fill='#63B3ED' />;
  }
  if (c.includes('cloud') || c.includes('overcast') || c.includes('fog')) {
    return <CloudyNight theme='filled' size='36' fill='#A0AEC0' />;
  }
  return <Sun theme='filled' size='36' fill='#F6AD55' />;
}

function getThemeColor(conditions: string): string {
  const c = (conditions || '').toLowerCase();
  if (c.includes('clear') || c.includes('sunny')) return 'rgb(var(--primary-6))';
  if (c.includes('rain') || c.includes('storm')) return 'rgb(var(--gray-7))';
  if (c.includes('cloud')) return 'rgb(var(--gray-6))';
  if (c.includes('snow')) return 'rgb(var(--blue-5))';
  return 'rgb(var(--purple-6))';
}

const WeatherCard: React.FC<ToolCardProps> = ({ args, result, status }) => {
  if (status === 'running') {
    return (
      <div className='rd-12px p-16px bg-[rgb(var(--primary-6))] text-white'>
        <span className='text-14px'>Retrieving weather data...</span>
      </div>
    );
  }

  const location = (args.location as string) || (result.city as string) || 'Unknown';
  const temperature = (result.temperature as number) ?? 0;
  const conditions = (result.conditions as string) || 'clear';
  const humidity = (result.humidity as number) ?? 0;
  const windSpeed = (result.wind_speed as number) ?? (result.windSpeed as number) ?? 0;
  const feelsLike = (result.feels_like as number) ?? (result.feelsLike as number) ?? temperature;

  return (
    <div
      className='rd-12px overflow-hidden mt-8px mb-4px max-w-400px'
      style={{ backgroundColor: getThemeColor(conditions) }}
    >
      <div className='p-16px' style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
        {/* Header */}
        <div className='flex items-center justify-between'>
          <div>
            <div className='text-18px font-bold text-white capitalize'>{location}</div>
            <div className='text-13px text-white/80 mt-2px'>Current Weather</div>
          </div>
          {getConditionIcon(conditions)}
        </div>

        {/* Temperature */}
        <div className='mt-16px flex items-end justify-between'>
          <div>
            <span className='text-28px font-bold text-white'>{String(temperature)}°C</span>
            <span className='text-12px text-white/50 ml-4px'>/ {((temperature * 9) / 5 + 32).toFixed(1)}°F</span>
          </div>
          <div className='text-13px text-white capitalize'>{conditions}</div>
        </div>

        {/* Stats grid */}
        <div className='mt-16px pt-12px border-t border-solid border-white/30'>
          <div className='grid grid-cols-3 gap-8px text-center'>
            <div>
              <div className='text-11px text-white/70'>Humidity</div>
              <div className='text-14px font-medium text-white'>{String(humidity)}%</div>
            </div>
            <div>
              <div className='text-11px text-white/70'>Wind</div>
              <div className='text-14px font-medium text-white'>{String(windSpeed)} mph</div>
            </div>
            <div>
              <div className='text-11px text-white/70'>Feels Like</div>
              <div className='text-14px font-medium text-white'>{String(feelsLike)}°</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WeatherCard;
