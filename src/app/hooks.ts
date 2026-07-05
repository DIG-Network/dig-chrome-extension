import { useDispatch, useSelector, useStore } from 'react-redux';
import type { AppDispatch, AppStore, RootState } from '@/app/store';

/** Typed `useDispatch`. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
/** Typed `useSelector`. */
export const useAppSelector = useSelector.withTypes<RootState>();
/** Typed `useStore`. */
export const useAppStore = useStore.withTypes<AppStore>();
