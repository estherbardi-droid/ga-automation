-- Drop views in dependency order
DROP VIEW client_tracking_tiers_v2;
DROP VIEW client_tracking_tiers;
DROP VIEW client_tracking_latest;

-- Alter the column
ALTER TABLE tracking_health_runs 
ALTER COLUMN health_reasons TYPE text USING health_reasons::text;

-- Recreate client_tracking_latest
CREATE OR REPLACE VIEW client_tracking_latest AS
SELECT DISTINCT ON (cid) id,
    client_name, ran_at, codes_on_site, detected_gtm_ids, detected_ga4_ids,
    health_status, evidence, cta_summary, cid, website_url, gads_summary,
    gads_conversion_actions, customer_id, supabase_id, health_reasons,
    phone_found, phone_tested, phone_passed, phone_failed,
    email_found, email_tested, email_passed, email_failed,
    forms_found, forms_passed, forms_failed, total_beacons,
    ga4_events_captured, cta_details, form_details, run_state, owner,
    order_number, last_run_at, site_status, completed_at, completed_by
FROM tracking_health_runs
WHERE cid IS NOT NULL AND TRIM(BOTH FROM cid) <> ''
ORDER BY cid, COALESCE(completed_at, ran_at, last_run_at) DESC NULLS LAST, id DESC;

-- Recreate client_tracking_tiers
CREATE OR REPLACE VIEW client_tracking_tiers AS
SELECT id, client_name, ran_at, codes_on_site, detected_gtm_ids, detected_ga4_ids,
    health_status, evidence, cta_summary, cid, website_url, gads_summary,
    gads_conversion_actions, customer_id, supabase_id, health_reasons,
    phone_found, phone_tested, phone_passed, phone_failed,
    email_found, email_tested, email_passed, email_failed,
    forms_found, forms_passed, forms_failed, total_beacons,
    ga4_events_captured, cta_details, form_details, run_state, owner,
    order_number, last_run_at, site_status, completed_at, completed_by,
    CASE
        WHEN site_status = 'PASS' AND (health_reasons IS NULL OR health_reasons = '' OR health_reasons = 'All CTA categories have at least one working conversion event') THEN 'T1: Perfect'
        WHEN site_status = 'PASS' AND health_reasons IS NOT NULL AND health_reasons != '' THEN 'T2: Working'
        WHEN site_status = 'NOT_TESTED' THEN 'T3: Partial'
        WHEN site_status = 'FAIL' THEN 'FAIL'
        WHEN site_status = 'ERROR' THEN 'ERROR'
        ELSE 'FAIL'
    END AS tier
FROM client_tracking_latest r;

-- Recreate client_tracking_tiers_v2
CREATE OR REPLACE VIEW client_tracking_tiers_v2 AS
SELECT c.cid,
    c.is_active,
    c.last_seen_in_monday_at AS client_last_seen_in_monday_at,
    r.id AS run_id, r.client_name, r.website_url, r.order_number,
    r.customer_id, r.supabase_id, r.ran_at, r.last_run_at, r.completed_at,
    r.codes_on_site, r.detected_gtm_ids, r.detected_ga4_ids,
    r.health_status, r.site_status, r.health_reasons, r.evidence,
    r.cta_summary, r.gads_summary, r.gads_conversion_actions,
    r.phone_found, r.phone_tested, r.phone_passed, r.phone_failed,
    r.email_found, r.email_tested, r.email_passed, r.email_failed,
    r.forms_found, r.forms_passed, r.forms_failed, r.total_beacons,
    r.ga4_events_captured, r.cta_details, r.form_details,
    r.run_state, r.owner, r.completed_by,
    CASE
        WHEN r.site_status = 'PASS' AND (r.health_reasons IS NULL OR r.health_reasons = '' OR r.health_reasons = 'All CTA categories have at least one working conversion event') THEN 'T1: Perfect'
        WHEN r.site_status = 'PASS' AND r.health_reasons IS NOT NULL AND r.health_reasons != '' THEN 'T2: Working'
        WHEN r.site_status = 'NOT_TESTED' THEN 'T3: Partial'
        WHEN r.site_status = 'FAIL' THEN 'FAIL'
        WHEN r.site_status = 'ERROR' THEN 'ERROR'
        ELSE 'FAIL'
    END AS tier
FROM clients c
LEFT JOIN (
    SELECT DISTINCT ON (tracking_health_runs.cid)
        tracking_health_runs.id, tracking_health_runs.client_name,
        tracking_health_runs.ran_at, tracking_health_runs.codes_on_site,
        tracking_health_runs.detected_gtm_ids, tracking_health_runs.detected_ga4_ids,
        tracking_health_runs.health_status, tracking_health_runs.evidence,
        tracking_health_runs.cta_summary, tracking_health_runs.cid,
        tracking_health_runs.website_url, tracking_health_runs.gads_summary,
        tracking_health_runs.gads_conversion_actions, tracking_health_runs.customer_id,
        tracking_health_runs.supabase_id, tracking_health_runs.health_reasons,
        tracking_health_runs.phone_found, tracking_health_runs.phone_tested,
        tracking_health_runs.phone_passed, tracking_health_runs.phone_failed,
        tracking_health_runs.email_found, tracking_health_runs.email_tested,
        tracking_health_runs.email_passed, tracking_health_runs.email_failed,
        tracking_health_runs.forms_found, tracking_health_runs.forms_passed,
        tracking_health_runs.forms_failed, tracking_health_runs.total_beacons,
        tracking_health_runs.ga4_events_captured, tracking_health_runs.cta_details,
        tracking_health_runs.form_details, tracking_health_runs.run_state,
        tracking_health_runs.owner, tracking_health_runs.order_number,
        tracking_health_runs.last_run_at, tracking_health_runs.site_status,
        tracking_health_runs.completed_at, tracking_health_runs.completed_by
    FROM tracking_health_runs
    WHERE tracking_health_runs.cid IS NOT NULL AND TRIM(BOTH FROM tracking_health_runs.cid) <> ''
    ORDER BY tracking_health_runs.cid, COALESCE(tracking_health_runs.completed_at, tracking_health_runs.ran_at, tracking_health_runs.last_run_at) DESC NULLS LAST, tracking_health_runs.id DESC
) r ON r.cid = c.cid
WHERE c.is_active = true AND r.ran_at IS NOT NULL;
