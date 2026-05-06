// frontend/src/hooks/usePolling.ts
// Wraps React Query's useQuery with refetchInterval
// Exposes: data, isLoading, isError, lastUpdated timestamp
// Shows "Live" green dot when polling is active, "Paused" when tab is hidden

import { useQuery, UseQueryOptions } from '@tanstack/react-query'
import { useState, useEffect } from 'react'

interface UsePollingResult<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  lastUpdated: Date | null
  isLive: boolean
}

export function usePolling<T>(
  queryKey: string[],
  queryFn: () => Promise<T>,
  options?: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>
): UsePollingResult<T> {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [isLive, setIsLive] = useState(true)

  useEffect(() => {
    const onVisibilityChange = () => setIsLive(!document.hidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  const { data, isLoading, isError, dataUpdatedAt } = useQuery<T, Error>({
    queryKey,
    queryFn,
    refetchInterval: isLive ? 5000 : false,
    staleTime: 0,
    ...options
  })

  useEffect(() => {
    if (dataUpdatedAt) setLastUpdated(new Date(dataUpdatedAt))
  }, [dataUpdatedAt])

  return { data, isLoading, isError, lastUpdated, isLive }
}
