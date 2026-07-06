// Generated from the live Supabase schema (project ldsxmigqfgfcisweqckk).
// Regenerate with the Supabase MCP `generate_typescript_types` tool or
// `supabase gen types typescript` after any schema change.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      claude_usage_sessions: {
        Row: {
          created_at: string;
          id: string;
          notes: string | null;
          session_ends_at: string;
          session_started_at: string;
          updated_at: string;
          usage_state: Database["public"]["Enums"]["usage_state"];
          user_id: string;
          weekly_window_ends_at: string | null;
          weekly_window_started_at: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          notes?: string | null;
          session_ends_at: string;
          session_started_at?: string;
          updated_at?: string;
          usage_state?: Database["public"]["Enums"]["usage_state"];
          user_id: string;
          weekly_window_ends_at?: string | null;
          weekly_window_started_at?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          notes?: string | null;
          session_ends_at?: string;
          session_started_at?: string;
          updated_at?: string;
          usage_state?: Database["public"]["Enums"]["usage_state"];
          user_id?: string;
          weekly_window_ends_at?: string | null;
          weekly_window_started_at?: string | null;
        };
        Relationships: [];
      };
      monthly_reports: {
        Row: {
          created_at: string;
          delivered_channels_json: Json | null;
          id: string;
          month_key: string;
          report_html: string | null;
          report_pdf_url: string | null;
          totals_json: Json | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          delivered_channels_json?: Json | null;
          id?: string;
          month_key: string;
          report_html?: string | null;
          report_pdf_url?: string | null;
          totals_json?: Json | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          delivered_channels_json?: Json | null;
          id?: string;
          month_key?: string;
          report_html?: string | null;
          report_pdf_url?: string | null;
          totals_json?: Json | null;
          user_id?: string;
        };
        Relationships: [];
      };
      music_presence: {
        Row: {
          album_art_url: string | null;
          album_name: string | null;
          artist_name: string | null;
          id: string;
          is_playing: boolean;
          source: string;
          track_title: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          album_art_url?: string | null;
          album_name?: string | null;
          artist_name?: string | null;
          id?: string;
          is_playing?: boolean;
          source?: string;
          track_title?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          album_art_url?: string | null;
          album_name?: string | null;
          artist_name?: string | null;
          id?: string;
          is_playing?: boolean;
          source?: string;
          track_title?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      notification_deliveries: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"];
          created_at: string;
          dedupe_key: string | null;
          error_message: string | null;
          id: string;
          payload_json: Json | null;
          scheduled_for: string;
          sent_at: string | null;
          status: Database["public"]["Enums"]["delivery_status"];
          subscription_id: string | null;
          user_id: string;
        };
        Insert: {
          channel: Database["public"]["Enums"]["notification_channel"];
          created_at?: string;
          dedupe_key?: string | null;
          error_message?: string | null;
          id?: string;
          payload_json?: Json | null;
          scheduled_for: string;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["delivery_status"];
          subscription_id?: string | null;
          user_id: string;
        };
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"];
          created_at?: string;
          dedupe_key?: string | null;
          error_message?: string | null;
          id?: string;
          payload_json?: Json | null;
          scheduled_for?: string;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["delivery_status"];
          subscription_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: false;
            referencedRelation: "subscriptions";
            referencedColumns: ["id"];
          },
        ];
      };
      subscription_notifications: {
        Row: {
          channel: Database["public"]["Enums"]["notification_channel"];
          created_at: string;
          enabled: boolean;
          id: string;
          reminder_offset_days: number;
          reminder_time_local: string;
          subscription_id: string;
          updated_at: string;
        };
        Insert: {
          channel: Database["public"]["Enums"]["notification_channel"];
          created_at?: string;
          enabled?: boolean;
          id?: string;
          reminder_offset_days: number;
          reminder_time_local?: string;
          subscription_id: string;
          updated_at?: string;
        };
        Update: {
          channel?: Database["public"]["Enums"]["notification_channel"];
          created_at?: string;
          enabled?: boolean;
          id?: string;
          reminder_offset_days?: number;
          reminder_time_local?: string;
          subscription_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscription_notifications_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: false;
            referencedRelation: "subscriptions";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          amount: number;
          billing_cycle: Database["public"]["Enums"]["billing_cycle"];
          category: Database["public"]["Enums"]["subscription_category"];
          color: string | null;
          created_at: string;
          currency: string;
          free_trial_end_at: string | null;
          icon_type: string;
          icon_url: string | null;
          id: string;
          interval_count: number;
          is_cancelled: boolean;
          is_paused: boolean;
          is_trial: boolean;
          name: string;
          next_renewal_at: string | null;
          notes: string | null;
          notification_channels: Database["public"]["Enums"]["notification_channel"][];
          plan_type: string | null;
          provider: string | null;
          reminder_offsets_days: number[];
          reminder_time_local: string;
          start_date: string;
          unsubscribe_url: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount?: number;
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"];
          category?: Database["public"]["Enums"]["subscription_category"];
          color?: string | null;
          created_at?: string;
          currency?: string;
          free_trial_end_at?: string | null;
          icon_type?: string;
          icon_url?: string | null;
          id?: string;
          interval_count?: number;
          is_cancelled?: boolean;
          is_paused?: boolean;
          is_trial?: boolean;
          name: string;
          next_renewal_at?: string | null;
          notes?: string | null;
          notification_channels?: Database["public"]["Enums"]["notification_channel"][];
          plan_type?: string | null;
          provider?: string | null;
          reminder_offsets_days?: number[];
          reminder_time_local?: string;
          start_date: string;
          unsubscribe_url?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"];
          category?: Database["public"]["Enums"]["subscription_category"];
          color?: string | null;
          created_at?: string;
          currency?: string;
          free_trial_end_at?: string | null;
          icon_type?: string;
          icon_url?: string | null;
          id?: string;
          interval_count?: number;
          is_cancelled?: boolean;
          is_paused?: boolean;
          is_trial?: boolean;
          name?: string;
          next_renewal_at?: string | null;
          notes?: string | null;
          notification_channels?: Database["public"]["Enums"]["notification_channel"][];
          plan_type?: string | null;
          provider?: string | null;
          reminder_offsets_days?: number[];
          reminder_time_local?: string;
          start_date?: string;
          unsubscribe_url?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_profiles: {
        Row: {
          created_at: string;
          full_name: string | null;
          monthly_report_enabled: boolean;
          preferred_currency: string;
          telegram_chat_id: string | null;
          telegram_enabled: boolean;
          theme: string;
          timezone: string;
          updated_at: string;
          user_id: string;
          whatsapp_enabled: boolean;
          whatsapp_phone: string | null;
          yearly_report_enabled: boolean;
        };
        Insert: {
          created_at?: string;
          full_name?: string | null;
          monthly_report_enabled?: boolean;
          preferred_currency?: string;
          telegram_chat_id?: string | null;
          telegram_enabled?: boolean;
          theme?: string;
          timezone?: string;
          updated_at?: string;
          user_id: string;
          whatsapp_enabled?: boolean;
          whatsapp_phone?: string | null;
          yearly_report_enabled?: boolean;
        };
        Update: {
          created_at?: string;
          full_name?: string | null;
          monthly_report_enabled?: boolean;
          preferred_currency?: string;
          telegram_chat_id?: string | null;
          telegram_enabled?: boolean;
          theme?: string;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
          whatsapp_enabled?: boolean;
          whatsapp_phone?: string | null;
          yearly_report_enabled?: boolean;
        };
        Relationships: [];
      };
      yearly_reports: {
        Row: {
          created_at: string;
          delivered_channels_json: Json | null;
          id: string;
          report_html: string | null;
          report_pdf_url: string | null;
          totals_json: Json | null;
          user_id: string;
          year_key: string;
        };
        Insert: {
          created_at?: string;
          delivered_channels_json?: Json | null;
          id?: string;
          report_html?: string | null;
          report_pdf_url?: string | null;
          totals_json?: Json | null;
          user_id: string;
          year_key: string;
        };
        Update: {
          created_at?: string;
          delivered_channels_json?: Json | null;
          id?: string;
          report_html?: string | null;
          report_pdf_url?: string | null;
          totals_json?: Json | null;
          user_id?: string;
          year_key?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      billing_cycle:
        | "weekly"
        | "monthly"
        | "quarterly"
        | "semiannual"
        | "annual"
        | "custom_days"
        | "custom_months"
        | "one_off";
      delivery_status: "pending" | "sent" | "failed" | "skipped";
      notification_channel: "telegram" | "whatsapp" | "email" | "in_app";
      subscription_category:
        | "streaming"
        | "utilities"
        | "saas"
        | "ai"
        | "music"
        | "gaming"
        | "productivity"
        | "finance"
        | "education"
        | "cloud"
        | "other";
      usage_state: "light" | "medium" | "heavy";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type Enums<T extends keyof PublicSchema["Enums"]> =
  PublicSchema["Enums"][T];
