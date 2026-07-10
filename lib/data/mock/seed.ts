import { addDays } from "date-fns";
import type { BillingCycle, Category, CurrencyCode } from "@/lib/constants";
import type { NotificationChannel, Subscription } from "@/types/subscription";
import { toISODate } from "@/lib/domain/dates";
import { nextChargeOnOrAfter } from "@/lib/domain/renewal";
import { DEMO_USER_ID } from "../types";

const now = () => new Date();
const isoIn = (days: number) => toISODate(addDays(now(), days));

/** A civil date on `day` of the month, `monthsAgo` months back (overflow-safe). */
function monthlyAnchor(day: number, monthsAgo = 5): string {
  const d = now();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(day);
  return toISODate(d);
}

interface SeedSpec {
  name: string;
  provider?: string;
  category: Category;
  amount: number;
  currency?: CurrencyCode;
  billingCycle: BillingCycle;
  intervalCount?: number;
  planType?: string;
  startDate: string;
  freeTrialEndAt?: string;
  isTrial?: boolean;
  isPaused?: boolean;
  isCancelled?: boolean;
  unsubscribeUrl?: string;
  color?: string;
  notes?: string;
  reminderOffsetsDays?: number[] | null;
  notificationChannels?: NotificationChannel[];
}

let sequence = 0;

function make(spec: SeedSpec): Subscription {
  const intervalCount = spec.intervalCount ?? 1;
  const isTrial = spec.isTrial ?? false;
  const freeTrialEndAt = spec.freeTrialEndAt ?? null;
  const anchor = isTrial && freeTrialEndAt ? freeTrialEndAt : spec.startDate;
  const nextDate =
    nextChargeOnOrAfter(anchor, spec.billingCycle, intervalCount, toISODate(now())) ??
    spec.startDate;
  const timestamp = new Date().toISOString();

  return {
    id: `sub_${(++sequence).toString().padStart(3, "0")}`,
    userId: DEMO_USER_ID,
    name: spec.name,
    provider: spec.provider ?? spec.name,
    category: spec.category,
    amount: spec.amount,
    currency: spec.currency ?? "USD",
    billingCycle: spec.billingCycle,
    intervalCount,
    planType: spec.planType ?? null,
    startDate: spec.startDate,
    nextRenewalAt: `${nextDate}T09:00:00.000Z`,
    freeTrialEndAt,
    isTrial,
    isPaused: spec.isPaused ?? false,
    isCancelled: spec.isCancelled ?? false,
    unsubscribeUrl: spec.unsubscribeUrl ?? null,
    iconType: "monogram",
    iconUrl: null,
    color: spec.color ?? null,
    notes: spec.notes ?? null,
    reminderOffsetsDays: spec.reminderOffsetsDays ?? null,
    reminderTimeLocal: "09:00",
    notificationChannels: spec.notificationChannels ?? ["in_app"],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Rich, always-current demo dataset. Dates are relative to "now". */
export function seedSubscriptions(): Subscription[] {
  sequence = 0;
  return [
    make({
      name: "Netflix",
      category: "streaming",
      amount: 17.99,
      billingCycle: "monthly",
      planType: "Premium",
      startDate: monthlyAnchor(14, 10),
      unsubscribeUrl: "https://www.netflix.com/cancelplan",
      notificationChannels: ["telegram", "in_app"],
    }),
    make({
      name: "Spotify",
      category: "music",
      amount: 11.99,
      billingCycle: "monthly",
      planType: "Premium Individual",
      startDate: monthlyAnchor(3, 8),
    }),
    make({
      name: "Claude Pro",
      provider: "Anthropic",
      category: "ai",
      amount: 20,
      billingCycle: "monthly",
      planType: "Pro",
      startDate: monthlyAnchor(21, 4),
      notes: "Rolling 5-hour + weekly usage limits.",
      notificationChannels: ["telegram", "in_app"],
    }),
    make({
      name: "ChatGPT Plus",
      provider: "OpenAI",
      category: "ai",
      amount: 20,
      billingCycle: "monthly",
      startDate: monthlyAnchor(9, 6),
    }),
    make({
      name: "Notion",
      category: "productivity",
      amount: 10,
      billingCycle: "monthly",
      planType: "Plus",
      startDate: monthlyAnchor(17, 5),
    }),
    make({
      name: "iCloud+",
      provider: "Apple",
      category: "cloud",
      amount: 2.99,
      billingCycle: "monthly",
      planType: "200GB",
      startDate: monthlyAnchor(1, 12),
    }),
    make({
      name: "YouTube Premium",
      provider: "Google",
      category: "streaming",
      amount: 13.99,
      billingCycle: "monthly",
      startDate: isoIn(-9),
      isTrial: true,
      freeTrialEndAt: isoIn(5),
      notes: "Free trial — converts to paid soon.",
      notificationChannels: ["telegram", "in_app"],
    }),
    make({
      name: "Adobe Creative Cloud",
      provider: "Adobe",
      category: "saas",
      amount: 59.99,
      billingCycle: "monthly",
      planType: "All Apps",
      startDate: monthlyAnchor(24, 7),
    }),
    make({
      name: "GitHub Copilot",
      provider: "GitHub",
      category: "saas",
      amount: 100,
      billingCycle: "annual",
      planType: "Individual (annual)",
      startDate: isoIn(20 - 365),
    }),
    make({
      name: "Xbox Game Pass Ultimate",
      provider: "Microsoft",
      category: "gaming",
      amount: 19.99,
      billingCycle: "monthly",
      startDate: monthlyAnchor(11, 3),
      isPaused: true,
      notes: "Paused until the next big release.",
    }),
    make({
      name: "Amazon Prime",
      provider: "Amazon",
      category: "streaming",
      amount: 139,
      billingCycle: "annual",
      planType: "Annual",
      startDate: isoIn(48 - 365),
    }),
    make({
      name: "Audible",
      provider: "Amazon",
      category: "education",
      amount: 14.95,
      billingCycle: "monthly",
      planType: "1 credit / month",
      startDate: isoIn(-28),
      isTrial: true,
      freeTrialEndAt: isoIn(2),
      notes: "Trial ends in a couple of days.",
    }),
    make({
      name: "Disney+",
      provider: "Disney",
      category: "streaming",
      amount: 13.99,
      billingCycle: "monthly",
      startDate: monthlyAnchor(8, 9),
      isCancelled: true,
      notes: "Cancelled — saving the monthly fee.",
    }),
  ];
}
