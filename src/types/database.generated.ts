
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "appointments": {
                  Row: {
                    "booking_window": unknown,"buffer_minutes_snapshot": number,"business_id": string,"cancellation_reason": string | null,"client_id": string,"completed_at": string | null,"created_at": string,"created_by": string | null,"creation_request_fingerprint": string | null,"creation_request_id": string | null,"currency": string,"duration_minutes_snapshot": number,"ends_at": string,"id": string,"internal_notes": string | null,"occupied_window": unknown,"price_cents_snapshot": number,"service_id": string,"service_name_snapshot": string,"starts_at": string,"status": Database["public"]['Enums']["appointment_status"],"updated_at": string,"version": number
                  }
                  Insert: {
                    "booking_window"?: never,"buffer_minutes_snapshot"?: number,"business_id": string,"cancellation_reason"?: string | null,"client_id": string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"creation_request_fingerprint"?: string | null,"creation_request_id"?: string | null,"currency"?: string,"duration_minutes_snapshot": number,"ends_at": string,"id"?: string,"internal_notes"?: string | null,"occupied_window": unknown,"price_cents_snapshot": number,"service_id": string,"service_name_snapshot": string,"starts_at": string,"status"?: Database["public"]['Enums']["appointment_status"],"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "booking_window"?: never,"buffer_minutes_snapshot"?: number,"business_id"?: string,"cancellation_reason"?: string | null,"client_id"?: string,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"creation_request_fingerprint"?: string | null,"creation_request_id"?: string | null,"currency"?: string,"duration_minutes_snapshot"?: number,"ends_at"?: string,"id"?: string,"internal_notes"?: string | null,"occupied_window"?: unknown,"price_cents_snapshot"?: number,"service_id"?: string,"service_name_snapshot"?: string,"starts_at"?: string,"status"?: Database["public"]['Enums']["appointment_status"],"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointments_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appointments_client_id_business_id_fkey"
      columns: ["client_id","business_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "appointments_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appointments_service_id_business_id_fkey"
      columns: ["service_id","business_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["id","business_id"]
    }
                  ]
                },"availability_exceptions": {
                  Row: {
                    "business_id": string,"created_at": string,"ends_at": string,"id": string,"kind": Database["public"]['Enums']["availability_exception_kind"],"reason": string | null,"starts_at": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"ends_at": string,"id"?: string,"kind": Database["public"]['Enums']["availability_exception_kind"],"reason"?: string | null,"starts_at": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"ends_at"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["availability_exception_kind"],"reason"?: string | null,"starts_at"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "availability_exceptions_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"business_hours": {
                  Row: {
                    "business_id": string,"created_at": string,"ends_at": string,"id": string,"starts_at": string,"updated_at": string,"weekday": number
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"ends_at": string,"id"?: string,"starts_at": string,"updated_at"?: string,"weekday": number
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"ends_at"?: string,"id"?: string,"starts_at"?: string,"updated_at"?: string,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_hours_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"business_members": {
                  Row: {
                    "business_id": string,"created_at": string,"id": string,"role": Database["public"]['Enums']["business_member_role"],"user_id": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"id"?: string,"role"?: Database["public"]['Enums']["business_member_role"],"user_id": string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"id"?: string,"role"?: Database["public"]['Enums']["business_member_role"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_members_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "business_members_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"business_onboardings": {
                  Row: {
                    "business_id": string,"completed_at": string,"user_id": string
                  }
                  Insert: {
                    "business_id": string,"completed_at"?: string,"user_id": string
                  }
                  Update: {
                    "business_id"?: string,"completed_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_onboardings_business_id_fkey"
      columns: ["business_id"]
isOneToOne: true
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "business_onboardings_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"business_settings": {
                  Row: {
                    "automatic_reactivation_enabled": boolean,"buffer_minutes": number,"business_id": string,"created_at": string,"currency": string,"maximum_booking_advance_days": number,"minimum_booking_notice_minutes": number,"reactivation_after_days": number,"slot_interval_minutes": number,"updated_at": string
                  }
                  Insert: {
                    "automatic_reactivation_enabled"?: boolean,"buffer_minutes"?: number,"business_id": string,"created_at"?: string,"currency"?: string,"maximum_booking_advance_days"?: number,"minimum_booking_notice_minutes"?: number,"reactivation_after_days"?: number,"slot_interval_minutes"?: number,"updated_at"?: string
                  }
                  Update: {
                    "automatic_reactivation_enabled"?: boolean,"buffer_minutes"?: number,"business_id"?: string,"created_at"?: string,"currency"?: string,"maximum_booking_advance_days"?: number,"minimum_booking_notice_minutes"?: number,"reactivation_after_days"?: number,"slot_interval_minutes"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_settings_business_id_fkey"
      columns: ["business_id"]
isOneToOne: true
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"businesses": {
                  Row: {
                    "cancellation_policy": string | null,"contact_email": string,"created_at": string,"created_by": string,"description": string | null,"id": string,"location": string | null,"logo_path": string | null,"name": string,"phone": string | null,"slug": string,"timezone": string,"updated_at": string
                  }
                  Insert: {
                    "cancellation_policy"?: string | null,"contact_email": string,"created_at"?: string,"created_by": string,"description"?: string | null,"id"?: string,"location"?: string | null,"logo_path"?: string | null,"name": string,"phone"?: string | null,"slug": string,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "cancellation_policy"?: string | null,"contact_email"?: string,"created_at"?: string,"created_by"?: string,"description"?: string | null,"id"?: string,"location"?: string | null,"logo_path"?: string | null,"name"?: string,"phone"?: string | null,"slug"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "businesses_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"calendar_connections": {
                  Row: {
                    "account_email": string | null,"business_id": string,"connected_by": string | null,"created_at": string,"credential_generation": string,"id": string,"last_error": string | null,"last_synced_at": string | null,"provider": string,"provider_account_id": string,"revocation_authorized_until": string | null,"revocation_pending_until": string | null,"scopes": (string)[],"status": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "account_email"?: string | null,"business_id": string,"connected_by"?: string | null,"created_at"?: string,"credential_generation"?: string,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"provider": string,"provider_account_id": string,"revocation_authorized_until"?: string | null,"revocation_pending_until"?: string | null,"scopes"?: (string)[],"status"?: string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "account_email"?: string | null,"business_id"?: string,"connected_by"?: string | null,"created_at"?: string,"credential_generation"?: string,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"provider"?: string,"provider_account_id"?: string,"revocation_authorized_until"?: string | null,"revocation_pending_until"?: string | null,"scopes"?: (string)[],"status"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_connections_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "business_id": string,"created_at": string,"email": string | null,"first_name": string,"id": string,"internal_notes": string | null,"last_name": string | null,"loyalty_token_hash": string | null,"phone": string | null,"updated_at": string
                  }
                  Insert: {
                    "business_id": string,"created_at"?: string,"email"?: string | null,"first_name": string,"id"?: string,"internal_notes"?: string | null,"last_name"?: string | null,"loyalty_token_hash"?: string | null,"phone"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "business_id"?: string,"created_at"?: string,"email"?: string | null,"first_name"?: string,"id"?: string,"internal_notes"?: string | null,"last_name"?: string | null,"loyalty_token_hash"?: string | null,"phone"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "clients_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"email_events": {
                  Row: {
                    "appointment_id": string | null,"attempt_count": number,"business_id": string,"client_id": string | null,"created_at": string,"dedupe_key": string,"id": string,"last_attempt_at": string | null,"last_error": string | null,"payload": NonNullable<Json>,"provider_message_id": string | null,"recipient_email": string,"scheduled_for": string,"sent_at": string | null,"status": Database["public"]['Enums']["email_event_status"],"type": Database["public"]['Enums']["email_event_type"],"updated_at": string
                  }
                  Insert: {
                    "appointment_id"?: string | null,"attempt_count"?: number,"business_id": string,"client_id"?: string | null,"created_at"?: string,"dedupe_key": string,"id"?: string,"last_attempt_at"?: string | null,"last_error"?: string | null,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"recipient_email": string,"scheduled_for"?: string,"sent_at"?: string | null,"status"?: Database["public"]['Enums']["email_event_status"],"type": Database["public"]['Enums']["email_event_type"],"updated_at"?: string
                  }
                  Update: {
                    "appointment_id"?: string | null,"attempt_count"?: number,"business_id"?: string,"client_id"?: string | null,"created_at"?: string,"dedupe_key"?: string,"id"?: string,"last_attempt_at"?: string | null,"last_error"?: string | null,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"recipient_email"?: string,"scheduled_for"?: string,"sent_at"?: string | null,"status"?: Database["public"]['Enums']["email_event_status"],"type"?: Database["public"]['Enums']["email_event_type"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_events_appointment_id_business_id_fkey"
      columns: ["appointment_id","business_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "email_events_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_events_client_id_business_id_fkey"
      columns: ["client_id","business_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id","business_id"]
    }
                  ]
                },"external_calendar_events": {
                  Row: {
                    "all_day": boolean,"all_day_end_date": string | null,"all_day_start_date": string | null,"all_day_zone": string | null,"business_id": string,"busy": boolean,"busy_window": unknown,"ends_at": string,"external_calendar_id": string,"id": string,"provider_etag": string | null,"provider_event_id": string,"provider_recurring_event_id": string | null,"provider_updated_at": string | null,"starts_at": string,"sync_generation": number,"synced_at": string
                  }
                  Insert: {
                    "all_day": boolean,"all_day_end_date"?: string | null,"all_day_start_date"?: string | null,"all_day_zone"?: string | null,"business_id": string,"busy": boolean,"busy_window"?: never,"ends_at": string,"external_calendar_id": string,"id"?: string,"provider_etag"?: string | null,"provider_event_id": string,"provider_recurring_event_id"?: string | null,"provider_updated_at"?: string | null,"starts_at": string,"sync_generation": number,"synced_at"?: string
                  }
                  Update: {
                    "all_day"?: boolean,"all_day_end_date"?: string | null,"all_day_start_date"?: string | null,"all_day_zone"?: string | null,"business_id"?: string,"busy"?: boolean,"busy_window"?: never,"ends_at"?: string,"external_calendar_id"?: string,"id"?: string,"provider_etag"?: string | null,"provider_event_id"?: string,"provider_recurring_event_id"?: string | null,"provider_updated_at"?: string | null,"starts_at"?: string,"sync_generation"?: number,"synced_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "external_calendar_events_external_calendar_id_business_id_fkey"
      columns: ["external_calendar_id","business_id"]
isOneToOne: false
      referencedRelation: "external_calendars"
      referencedColumns: ["id","business_id"]
    }
                  ]
                },"external_calendars": {
                  Row: {
                    "access_role": string | null,"business_id": string,"connection_id": string,"created_at": string,"id": string,"is_primary": boolean,"last_error": string | null,"last_synced_at": string | null,"name": string,"provider_calendar_id": string,"selected_for_blocking": boolean,"sync_status": string,"timezone": string | null,"updated_at": string
                  }
                  Insert: {
                    "access_role"?: string | null,"business_id": string,"connection_id": string,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"last_error"?: string | null,"last_synced_at"?: string | null,"name": string,"provider_calendar_id": string,"selected_for_blocking"?: boolean,"sync_status"?: string,"timezone"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "access_role"?: string | null,"business_id"?: string,"connection_id"?: string,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"last_error"?: string | null,"last_synced_at"?: string | null,"name"?: string,"provider_calendar_id"?: string,"selected_for_blocking"?: boolean,"sync_status"?: string,"timezone"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "external_calendars_connection_id_business_id_fkey"
      columns: ["connection_id","business_id"]
isOneToOne: false
      referencedRelation: "calendar_connections"
      referencedColumns: ["id","business_id"]
    }
                  ]
                },"loyalty_events": {
                  Row: {
                    "appointment_id": string | null,"business_id": string,"client_id": string,"created_at": string,"created_by": string | null,"id": string,"idempotency_key": string,"points_delta": number,"reason": string,"type": Database["public"]['Enums']["loyalty_event_type"]
                  }
                  Insert: {
                    "appointment_id"?: string | null,"business_id": string,"client_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"idempotency_key": string,"points_delta": number,"reason": string,"type": Database["public"]['Enums']["loyalty_event_type"]
                  }
                  Update: {
                    "appointment_id"?: string | null,"business_id"?: string,"client_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"idempotency_key"?: string,"points_delta"?: number,"reason"?: string,"type"?: Database["public"]['Enums']["loyalty_event_type"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "loyalty_events_appointment_id_business_id_fkey"
      columns: ["appointment_id","business_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "loyalty_events_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "loyalty_events_client_id_business_id_fkey"
      columns: ["client_id","business_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "loyalty_events_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"loyalty_programs": {
                  Row: {
                    "accrual_mode": Database["public"]['Enums']["loyalty_accrual_mode"],"active": boolean,"business_id": string,"created_at": string,"points_per_completed_appointment": number,"points_per_euro": number | null,"updated_at": string
                  }
                  Insert: {
                    "accrual_mode"?: Database["public"]['Enums']["loyalty_accrual_mode"],"active"?: boolean,"business_id": string,"created_at"?: string,"points_per_completed_appointment"?: number,"points_per_euro"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "accrual_mode"?: Database["public"]['Enums']["loyalty_accrual_mode"],"active"?: boolean,"business_id"?: string,"created_at"?: string,"points_per_completed_appointment"?: number,"points_per_euro"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "loyalty_programs_business_id_fkey"
      columns: ["business_id"]
isOneToOne: true
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"first_name": string | null,"id": string,"last_name": string | null,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"first_name"?: string | null,"id": string,"last_name"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"first_name"?: string | null,"id"?: string,"last_name"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reward_redemptions": {
                  Row: {
                    "appointment_id": string | null,"business_id": string,"client_id": string,"created_by": string | null,"id": string,"loyalty_event_id": string,"points_spent": number,"redeemed_at": string,"reward_id": string
                  }
                  Insert: {
                    "appointment_id"?: string | null,"business_id": string,"client_id": string,"created_by"?: string | null,"id"?: string,"loyalty_event_id": string,"points_spent": number,"redeemed_at"?: string,"reward_id": string
                  }
                  Update: {
                    "appointment_id"?: string | null,"business_id"?: string,"client_id"?: string,"created_by"?: string | null,"id"?: string,"loyalty_event_id"?: string,"points_spent"?: number,"redeemed_at"?: string,"reward_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reward_redemptions_appointment_id_business_id_fkey"
      columns: ["appointment_id","business_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "reward_redemptions_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reward_redemptions_client_id_business_id_fkey"
      columns: ["client_id","business_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "reward_redemptions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reward_redemptions_loyalty_event_id_business_id_fkey"
      columns: ["loyalty_event_id","business_id"]
isOneToOne: false
      referencedRelation: "loyalty_events"
      referencedColumns: ["id","business_id"]
    },{
      foreignKeyName: "reward_redemptions_reward_id_business_id_fkey"
      columns: ["reward_id","business_id"]
isOneToOne: false
      referencedRelation: "rewards"
      referencedColumns: ["id","business_id"]
    }
                  ]
                },"rewards": {
                  Row: {
                    "active": boolean,"business_id": string,"created_at": string,"description": string | null,"id": string,"name": string,"points_required": number,"reward_type": Database["public"]['Enums']["reward_type"],"reward_value": number | null,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"business_id": string,"created_at"?: string,"description"?: string | null,"id"?: string,"name": string,"points_required": number,"reward_type": Database["public"]['Enums']["reward_type"],"reward_value"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"business_id"?: string,"created_at"?: string,"description"?: string | null,"id"?: string,"name"?: string,"points_required"?: number,"reward_type"?: Database["public"]['Enums']["reward_type"],"reward_value"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rewards_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                },"services": {
                  Row: {
                    "active": boolean,"business_id": string,"created_at": string,"description": string | null,"display_order": number,"duration_minutes": number,"id": string,"name": string,"price_cents": number,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"business_id": string,"created_at"?: string,"description"?: string | null,"display_order"?: number,"duration_minutes": number,"id"?: string,"name": string,"price_cents": number,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"business_id"?: string,"created_at"?: string,"description"?: string | null,"display_order"?: number,"duration_minutes"?: number,"id"?: string,"name"?: string,"price_cents"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "services_business_id_fkey"
      columns: ["business_id"]
isOneToOne: false
      referencedRelation: "businesses"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "agenda_create_appointment":
{ Args: { "p_business_id": string,"p_client_email"?: string,"p_client_first_name"?: string,"p_client_id"?: string,"p_client_last_name"?: string,"p_client_phone"?: string,"p_internal_notes"?: string,"p_request_id"?: string,"p_service_id": string,"p_starts_at": string }; Returns: {
              "appointment_id": string,"created": boolean
            }[]
                           },
"agenda_set_appointment_status":
{ Args: { "p_appointment_id": string,"p_business_id": string,"p_cancellation_reason"?: string,"p_expected_version": number,"p_status": Database["public"]['Enums']["appointment_status"] }; Returns: string
                           },
"agenda_update_appointment":
{ Args: { "p_appointment_id": string,"p_business_id": string,"p_client_id": string,"p_expected_version": number,"p_internal_notes"?: string,"p_service_id": string,"p_starts_at"?: string }; Returns: string
                           },
"business_time":
{ Args: { "p_business_id": string,"p_dates"?: (string)[],"p_instants"?: (string)[],"p_locals"?: (string)[],"p_open_ranges"?: boolean }; Returns: Json
                           },
"calendar_apply_events":
{ Args: { "p_calendar_id": string,"p_claim_id": string,"p_events": Json,"p_generation": number,"p_next_page_token"?: string,"p_provider_timezone": string }; Returns: Json
                           },
"calendar_begin_oauth":
{ Args: { "p_business_id": string,"p_code_verifier_ciphertext": string,"p_provider": string,"p_state_hash": string }; Returns: undefined
                           },
"calendar_begin_revocation":
{ Args: { "p_connection_id": string,"p_generation": string }; Returns: number
                           },
"calendar_claim_sync":
{ Args: { "p_calendar_id": string,"p_lease_seconds"?: number }; Returns: Json
                           },
"calendar_conflicts":
{ Args: { "p_business_id": string,"p_from": string,"p_to": string }; Returns: {
              "appointment_ends_at": string,"appointment_id": string,"appointment_starts_at": string,"event_ends_at": string,"event_starts_at": string,"external_calendar_id": string
            }[]
                           },
"calendar_consume_oauth_state":
{ Args: { "p_state_hash": string }; Returns: {
              "business_id": string,"code_verifier_ciphertext": string,"provider": string
            }[]
                           },
"calendar_disconnect":
{ Args: { "p_connection_id": string,"p_generation": string }; Returns: Json
                           },
"calendar_due_work":
{ Args: { "p_limit"?: number,"p_with_channels"?: boolean }; Returns: {
              "calendar_id": string,"reason": string
            }[]
                           },
"calendar_finish_full_sync":
{ Args: { "p_calendar_id": string,"p_claim_id": string,"p_generation": number,"p_sync_token": string }; Returns: boolean
                           },
"calendar_finish_incremental_sync":
{ Args: { "p_calendar_id": string,"p_claim_id": string,"p_sync_token": string }; Returns: boolean
                           },
"calendar_mark_reauth_required":
{ Args: { "p_connection_id": string,"p_error": string,"p_generation": string }; Returns: boolean
                           },
"calendar_read_secrets":
{ Args: { "p_connection_id": string }; Returns: {
              "access_token_ciphertext": string,"access_token_expires_at": string,"business_id": string,"credential_generation": string,"provider": string,"refresh_token_ciphertext": string,"secret_version": number,"status": string
            }[]
                           },
"calendar_record_channel":
{ Args: { "p_calendar_id": string,"p_channel_id": string,"p_claim_id": string,"p_expires_at": string,"p_resource_id": string,"p_token_hash": string }; Returns: Json
                           },
"calendar_reencrypt_secrets":
{ Args: { "p_access_token_ciphertext": string,"p_connection_id": string,"p_generation": string,"p_refresh_token_ciphertext": string,"p_secret_version": number }; Returns: boolean
                           },
"calendar_release_sync":
{ Args: { "p_calendar_id": string,"p_claim_id": string,"p_error"?: string,"p_outcome": string }; Returns: boolean
                           },
"calendar_reset_sync":
{ Args: { "p_calendar_id": string,"p_claim_id": string }; Returns: boolean
                           },
"calendar_revocation_done":
{ Args: { "p_connection_id": string,"p_generation": string }; Returns: undefined
                           },
"calendar_save_calendars":
{ Args: { "p_calendars": Json,"p_connection_id": string,"p_generation": string }; Returns: boolean
                           },
"calendar_save_connection":
{ Args: { "p_access_token_ciphertext": string,"p_access_token_expires_at": string,"p_account_email": string,"p_business_id": string,"p_calendars": Json,"p_provider": string,"p_provider_account_id": string,"p_refresh_token_ciphertext": string,"p_scopes": (string)[],"p_user_id": string }; Returns: string
                           },
"calendar_set_blocking":
{ Args: { "p_business_id": string,"p_calendar_ids": (string)[] }; Returns: Json
                           },
"calendar_start_full_sync":
{ Args: { "p_calendar_id": string,"p_claim_id": string }; Returns: Json
                           },
"calendar_store_access_token":
{ Args: { "p_access_token_ciphertext": string,"p_access_token_expires_at": string,"p_connection_id": string,"p_generation": string }; Returns: boolean
                           },
"calendar_verify_notification":
{ Args: { "p_channel_id": string,"p_resource_id": string,"p_token_hash": string }; Returns: string
                           },
"check_slug_availability":
{ Args: { "p_slug": string }; Returns: {
              "available": boolean,"reason": string,"slug": string
            }[]
                           },
"complete_onboarding":
{ Args: { "p_buffer_minutes"?: number,"p_business_name": string,"p_cancellation_policy"?: string,"p_contact_email"?: string,"p_description"?: string,"p_first_name": string,"p_last_name": string,"p_location"?: string,"p_maximum_booking_advance_days"?: number,"p_minimum_booking_notice_minutes"?: number,"p_phone"?: string,"p_slug": string,"p_timezone"?: string }; Returns: {
              "business_id": string,"business_name": string,"slug": string,"timezone": string
            }[]
                           },
"create_public_booking":
{ Args: { "p_email": string,"p_first_name": string,"p_last_name"?: string,"p_phone"?: string,"p_service_id": string,"p_slug": string,"p_starts_at": string }; Returns: {
              "appointment_id": string,"business_name": string,"currency": string,"duration_minutes": number,"ends_at": string,"price_cents": number,"service_name": string,"starts_at": string,"timezone": string
            }[]
                           },
"get_available_slots":
{ Args: { "p_date": string,"p_service_id": string,"p_slug": string }; Returns: {
              "ends_at": string,"local_ends_at": string,"local_starts_at": string,"starts_at": string
            }[]
                           },
"get_public_business":
{ Args: { "p_slug": string }; Returns: {
              "cancellation_policy": string,"currency": string,"description": string,"location": string,"logo_path": string,"maximum_booking_advance_days": number,"minimum_booking_notice_minutes": number,"name": string,"slot_interval_minutes": number,"slug": string,"timezone": string
            }[]
                           },
"get_public_services":
{ Args: { "p_slug": string }; Returns: {
              "currency": string,"description": string,"display_order": number,"duration_minutes": number,"id": string,"name": string,"price_cents": number
            }[]
                           },
"has_business_role":
{ Args: { "accepted_roles": (Database["public"]['Enums']["business_member_role"])[],"target_business_id": string }; Returns: boolean
                           },
"is_business_member":
{ Args: { "target_business_id": string }; Returns: boolean
                           },
"reorder_services":
{ Args: { "p_business_id": string,"p_service_ids": (string)[] }; Returns: undefined
                           },
"replace_business_hours":
{ Args: { "p_business_id": string,"p_hours": Json }; Returns: {
              "business_id": string,
"created_at": string,
"ends_at": string,
"id": string,
"starts_at": string,
"updated_at": string,
"weekday": number
            }[]
                          SetofOptions: {
        from: "*"
        to: "business_hours"
        isOneToOne: false
        isSetofReturn: true
      } },
"search_clients":
{ Args: { "p_business_id": string,"p_limit"?: number,"p_query": string }; Returns: {
              "email": string,"first_name": string,"id": string,"last_name": string,"phone": string
            }[]
                           }
          }
          Enums: {
            "appointment_status": "confirmed"|"completed"|"cancelled"|"no_show","availability_exception_kind": "closed"|"blocked"|"open_override","business_member_role": "owner"|"admin","email_event_status": "pending"|"processing"|"sent"|"failed"|"cancelled","email_event_type": "booking_confirmation"|"appointment_reminder"|"appointment_changed"|"appointment_cancelled"|"points_earned"|"reward_unlocked"|"reactivation","loyalty_accrual_mode": "appointment"|"spend","loyalty_event_type": "appointment_completed"|"manual_adjustment"|"reward_redeemed"|"correction","reward_type": "percentage_discount"|"fixed_discount"|"free_service"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "appointment_status": ["confirmed", "completed", "cancelled", "no_show"],"availability_exception_kind": ["closed", "blocked", "open_override"],"business_member_role": ["owner", "admin"],"email_event_status": ["pending", "processing", "sent", "failed", "cancelled"],"email_event_type": ["booking_confirmation", "appointment_reminder", "appointment_changed", "appointment_cancelled", "points_earned", "reward_unlocked", "reactivation"],"loyalty_accrual_mode": ["appointment", "spend"],"loyalty_event_type": ["appointment_completed", "manual_adjustment", "reward_redeemed", "correction"],"reward_type": ["percentage_discount", "fixed_discount", "free_service"]
          }
        }
} as const

