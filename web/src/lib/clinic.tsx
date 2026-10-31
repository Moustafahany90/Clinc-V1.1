import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { DEFAULT_CURRENCY, DEFAULT_TZ } from './format';
import type { Clinic, DoctorOption, PaymentMethod, Service } from './types';

interface ClinicContextValue {
  clinic: Clinic | null;
  currency: string;
  timezone: string;
  clinicName: string;
  refreshClinic: () => Promise<void>;
  doctors: DoctorOption[];
  services: Service[];
  paymentMethods: PaymentMethod[];
  refreshDoctors: () => Promise<DoctorOption[]>;
  refreshServices: () => Promise<Service[]>;
  refreshPaymentMethods: () => Promise<PaymentMethod[]>;
}

const ClinicContext = createContext<ClinicContextValue | null>(null);

export function ClinicProvider({ children }: { children: ReactNode }) {
  const { user, hasPermission } = useAuth();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  const refreshClinic = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get<{ clinic: Clinic }>('/settings');
      setClinic(res.data.clinic);
    } catch {
      // Non-critical; fall back to defaults.
    }
  }, [user]);

  const refreshDoctors = useCallback(async () => {
    if (!user) return [];
    if (!hasPermission('APPOINTMENTS_READ') && !hasPermission('USERS_MANAGE')) return [];
    try {
      const res = await api.get<{ doctors: DoctorOption[] }>('/users/doctors');
      setDoctors(res.data.doctors);
      return res.data.doctors;
    } catch {
      return [];
    }
  }, [user, hasPermission]);

  const refreshServices = useCallback(async () => {
    if (!user) return [];
    if (!hasPermission('APPOINTMENTS_READ') && !hasPermission('SETTINGS_MANAGE')) return [];
    try {
      const res = await api.get<{ services: Service[] }>('/settings/services');
      setServices(res.data.services);
      return res.data.services;
    } catch {
      return [];
    }
  }, [user, hasPermission]);

  const refreshPaymentMethods = useCallback(async () => {
    if (!user) return [];
    if (
      !hasPermission('PAYMENTS_READ') &&
      !hasPermission('PAYMENTS_WRITE') &&
      !hasPermission('SETTINGS_MANAGE')
    ) {
      return [];
    }
    try {
      const res = await api.get<{ paymentMethods: PaymentMethod[] }>('/settings/payment-methods');
      setPaymentMethods(res.data.paymentMethods);
      return res.data.paymentMethods;
    } catch {
      return [];
    }
  }, [user, hasPermission]);

  useEffect(() => {
    if (!user) {
      setClinic(null);
      setDoctors([]);
      setServices([]);
      setPaymentMethods([]);
      return;
    }
    void refreshClinic();
    void refreshDoctors();
    void refreshServices();
    void refreshPaymentMethods();
  }, [user, refreshClinic, refreshDoctors, refreshServices, refreshPaymentMethods]);

  const value = useMemo<ClinicContextValue>(
    () => ({
      clinic,
      currency: clinic?.currency ?? DEFAULT_CURRENCY,
      timezone: clinic?.timezone ?? DEFAULT_TZ,
      clinicName: clinic?.name ?? 'Ultrasound Clinic',
      refreshClinic,
      doctors,
      services,
      paymentMethods,
      refreshDoctors,
      refreshServices,
      refreshPaymentMethods,
    }),
    [
      clinic,
      refreshClinic,
      doctors,
      services,
      paymentMethods,
      refreshDoctors,
      refreshServices,
      refreshPaymentMethods,
    ],
  );

  return <ClinicContext.Provider value={value}>{children}</ClinicContext.Provider>;
}

export function useClinic(): ClinicContextValue {
  const ctx = useContext(ClinicContext);
  if (!ctx) throw new Error('useClinic must be used inside ClinicProvider');
  return ctx;
}
