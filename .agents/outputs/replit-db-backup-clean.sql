--
-- PostgreSQL database dump
--


-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: artwork_condition; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.artwork_condition AS ENUM (
    'EXCELLENT',
    'GOOD',
    'FAIR',
    'POOR'
);


--
-- Name: artwork_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.artwork_status AS ENUM (
    'AVAILABLE',
    'SOLD',
    'RESERVED',
    'HIDDEN'
);


--
-- Name: fulfillment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fulfillment_type AS ENUM (
    'SHIP',
    'PICKUP',
    'FRAMING_JOB'
);


--
-- Name: inquiry_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.inquiry_status AS ENUM (
    'NEW',
    'HANDLED'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'PENDING',
    'PAID',
    'FULFILLED',
    'CANCELLED'
);


--
-- Name: tenant_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tenant_type AS ENUM (
    'ARTIST',
    'FRAMER'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_user (
    id text DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artwork; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    represented_artist_id text,
    title text NOT NULL,
    sku text NOT NULL,
    medium text,
    dimensions_w integer,
    dimensions_h integer,
    dimensions_d integer,
    condition public.artwork_condition,
    price integer,
    status public.artwork_status DEFAULT 'AVAILABLE'::public.artwork_status NOT NULL,
    show_in_gallery boolean DEFAULT true NOT NULL,
    notes text,
    is_edition boolean DEFAULT false NOT NULL,
    edition_number integer,
    total_editions integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artwork_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_category (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artwork_category_on_artwork; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_category_on_artwork (
    artwork_id text NOT NULL,
    category_id text NOT NULL
);


--
-- Name: artwork_image; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_image (
    id text DEFAULT gen_random_uuid() NOT NULL,
    artwork_id text NOT NULL,
    tenant_id text NOT NULL,
    object_path text NOT NULL,
    filename text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inquiry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inquiry (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    artwork_id text NOT NULL,
    artwork_title text NOT NULL,
    buyer_name text NOT NULL,
    buyer_email text NOT NULL,
    message text NOT NULL,
    email_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status public.inquiry_status DEFAULT 'NEW'::public.inquiry_status NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: inquiry_reply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inquiry_reply (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    inquiry_id text NOT NULL,
    message text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_by_user_id text
);


--
-- Name: order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."order" (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    stripe_session_id text,
    stripe_payment_intent_id text,
    buyer_email text NOT NULL,
    buyer_name text,
    status public.order_status DEFAULT 'PENDING'::public.order_status NOT NULL,
    fulfillment_type public.fulfillment_type NOT NULL,
    total_cents integer NOT NULL,
    application_fee_cents integer,
    tracking_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    iframer_job_id text,
    iframer_job_error text,
    email_sent_at timestamp with time zone,
    email_error text,
    email_attempts integer DEFAULT 0 NOT NULL,
    email_last_attempt_at timestamp with time zone,
    status_email_queued_at timestamp with time zone,
    status_email_error text,
    status_email_attempts integer DEFAULT 0 NOT NULL,
    status_email_last_attempt_at timestamp with time zone,
    email_failure_notified_at timestamp with time zone,
    refunded_amount_cents integer,
    refunded_at timestamp with time zone,
    stripe_refund_id text
);


--
-- Name: order_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item (
    id text DEFAULT gen_random_uuid() NOT NULL,
    order_id text NOT NULL,
    artwork_id text NOT NULL,
    tenant_id text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    price_cents integer NOT NULL,
    artwork_title text NOT NULL,
    artwork_sku text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rate_limit_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_event (
    id text DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: represented_artist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.represented_artist (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    bio text,
    commission_pct integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_invite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_invite (
    id text DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'staff'::text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_alert (
    id text DEFAULT gen_random_uuid() NOT NULL,
    stripe_event_id text NOT NULL,
    event_type text NOT NULL,
    customer_id text,
    subscription_id text,
    reason text NOT NULL,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    slack_post_failed timestamp with time zone
);


--
-- Name: tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant (
    id text DEFAULT gen_random_uuid() NOT NULL,
    type public.tenant_type NOT NULL,
    business_name text NOT NULL,
    slug text NOT NULL,
    custom_domain text,
    custom_domain_verified boolean DEFAULT false NOT NULL,
    storefront_enabled boolean DEFAULT true NOT NULL,
    logo_url text,
    theme_color text,
    about_text text,
    stripe_account_id text,
    iframer_account_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_email text,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_status text,
    billing_exempt boolean DEFAULT false NOT NULL
);


--
-- Name: tenant_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_user (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL
);


--
-- Data for Name: app_user; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_user (id, email, password_hash, created_at) FROM stdin;
3400ab51-cf9b-4432-bf4b-9d4d56416340	jane@janesmith.studio	$2a$12$Sth3V13z2WLvFsd1F53/TeeVqr0aYzKJrZSZuELpYGwxvdUHeMZ/G	2026-07-18 06:19:01.965318+00
71f1d92e-16c1-4b50-9bda-1c8a9cb2b102	admin@frameworks.com.au	$2a$12$Sth3V13z2WLvFsd1F53/TeeVqr0aYzKJrZSZuELpYGwxvdUHeMZ/G	2026-07-18 06:19:01.978792+00
313de9b4-0baa-408f-9bb9-9184dbeb9e15	mark@anokah.com.au	$2a$12$8UvLvRFqQuVxPAR.TSTw6.5fQ5dyZDlkQpQaTFQXmRk4H/6Y2MOOC	2026-07-18 08:18:49.277931+00
\.


--
-- Data for Name: artwork; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.artwork (id, tenant_id, represented_artist_id, title, sku, medium, dimensions_w, dimensions_h, dimensions_d, condition, price, status, show_in_gallery, notes, is_edition, edition_number, total_editions, created_at, updated_at) FROM stdin;
19846989-ce6f-415f-b81b-115ce19d1806	d16f3ded-37d7-428e-a588-7d82474aede2	\N	LgYZB2	rXCgDt	\N	\N	\N	\N	\N	\N	AVAILABLE	t	\N	f	\N	\N	2026-07-18 08:57:52.762784+00	2026-07-18 08:57:52.762784+00
0373e055-401f-4945-93ca-a43b597c2f1f	2a824086-e683-41a6-8099-fb191c95bde0	\N	Mark1	MS-001	oil on linen	500	500	40	EXCELLENT	100000	AVAILABLE	t	\N	f	\N	\N	2026-07-18 08:42:59.97053+00	2026-07-18 09:41:41.215+00
95872447-fdf8-41ba-96f4-a5b8964dc955	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Mark Test	MT-001	oil on linen	500	500	40	EXCELLENT	100000	AVAILABLE	t	beautiful	f	\N	\N	2026-07-23 00:41:03.19576+00	2026-07-23 00:41:03.19576+00
cfdd593d-b5ac-43a7-b6f4-653fde94b08f	8f1fb163-d413-418f-9554-73382711b2d0	c61fd2ce-8781-4a37-9e02-073fc298d3cc	Geometry in Blue	FW-001	Mixed media on canvas	800	800	\N	EXCELLENT	240000	AVAILABLE	t	\N	f	\N	\N	2026-07-28 03:46:49.387377+00	2026-07-28 03:46:49.387377+00
d3f4e8ea-0cbf-46c7-8603-d6250417c835	8f1fb163-d413-418f-9554-73382711b2d0	c61fd2ce-8781-4a37-9e02-073fc298d3cc	Red Series No. 7	FW-002	Oil on canvas	1000	700	\N	EXCELLENT	380000	AVAILABLE	t	\N	f	\N	\N	2026-07-28 03:46:49.387377+00	2026-07-28 03:46:49.387377+00
2986211d-1125-4ba6-81d0-6b113c6ffb24	8f1fb163-d413-418f-9554-73382711b2d0	\N	Still Life with Lemons	FW-003	Oil on board	400	300	\N	GOOD	160000	SOLD	t	\N	f	\N	\N	2026-07-28 03:46:49.387377+00	2026-07-28 03:46:49.387377+00
016cf12a-7910-4b33-93b7-1dab0c44a713	8f1fb163-d413-418f-9554-73382711b2d0	\N	Abstract Study IV	FW-004	Watercolour on paper	420	297	\N	EXCELLENT	95000	AVAILABLE	t	\N	f	\N	\N	2026-07-28 03:46:49.387377+00	2026-07-28 03:46:49.387377+00
9a6517ac-f71b-43f8-83df-65042abd6fb6	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Blue Mountains at Dusk	JS-001	Oil on linen	760	610	\N	EXCELLENT	450000	AVAILABLE	t	Framed in natural timber. Certificate of authenticity included.	f	\N	\N	2026-07-28 03:47:36.748664+00	2026-07-28 03:47:36.748664+00
230e2f31-79d7-4557-9c2e-b48ee287ab0e	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Morning Light, Kangaroo Valley	JS-002	Watercolour on paper	560	380	\N	EXCELLENT	320000	AVAILABLE	t	\N	f	\N	\N	2026-07-28 03:47:36.748664+00	2026-07-28 03:47:36.748664+00
e37689de-34de-435b-8370-253e1848aa6f	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Coastal Study No. 3	JS-003	Pastel on board	300	300	\N	GOOD	180000	AVAILABLE	t	\N	t	1	5	2026-07-28 03:47:36.748664+00	2026-07-28 03:47:36.748664+00
8f9d9ef3-8bef-43eb-ae55-6b401b13ac83	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Sydney Harbour, Winter	JS-004	Oil on board	915	610	\N	EXCELLENT	550000	SOLD	t	\N	f	\N	\N	2026-07-28 03:47:36.748664+00	2026-07-28 03:47:36.748664+00
32490371-7779-40bb-a877-9fe7b8b084b8	d16f3ded-37d7-428e-a588-7d82474aede2	\N	Outback Red	JS-005	Acrylic on linen	1200	900	\N	EXCELLENT	220000	HIDDEN	f	Work in progress — not ready for public listing.	f	\N	\N	2026-07-28 03:47:36.748664+00	2026-07-28 03:47:36.748664+00
\.


--
-- Data for Name: artwork_category; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.artwork_category (id, tenant_id, name, created_at) FROM stdin;
\.


--
-- Data for Name: artwork_category_on_artwork; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.artwork_category_on_artwork (artwork_id, category_id) FROM stdin;
\.


--
-- Data for Name: artwork_image; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.artwork_image (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary, created_at) FROM stdin;
271a2a16-083a-47dc-8bdd-cab0e1baa687	19846989-ce6f-415f-b81b-115ce19d1806	d16f3ded-37d7-428e-a588-7d82474aede2	/objects/uploads/fcc79f67-affa-47bf-abec-8eb7efa6ee6e	test-upload.png	0	t	2026-07-18 08:58:14.365001+00
5308db76-d51e-44d5-bb29-88bb35c6adc8	0373e055-401f-4945-93ca-a43b597c2f1f	2a824086-e683-41a6-8099-fb191c95bde0	/objects/uploads/804e0db7-44da-4058-8959-723ac17ed0b1	image_3da8f4ae.png	0	t	2026-07-18 09:41:02.323473+00
c2244fbd-8a86-4239-a660-af159636de03	95872447-fdf8-41ba-96f4-a5b8964dc955	d16f3ded-37d7-428e-a588-7d82474aede2	/objects/uploads/ff61e686-5bcb-4508-9303-559294ab42c0	image_3da8f4ae.png	0	t	2026-07-23 00:41:21.151683+00
\.


--
-- Data for Name: inquiry; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.inquiry (id, tenant_id, artwork_id, artwork_title, buyer_name, buyer_email, message, email_error, created_at, status, archived_at) FROM stdin;
bfd01516-0c9f-4a4c-b999-cf1cca94511a	8f1fb163-d413-418f-9554-73382711b2d0	cfdd593d-b5ac-43a7-b6f4-653fde94b08f	Geometry in Blue	Lisa Park	lisa.park@example.com	Hello, I'm interested in Geometry in Blue — can you tell me more about Michael Torres? Does the piece come framed?	\N	2026-07-28 03:46:49.403681+00	NEW	\N
a59afc8a-adb0-41ce-9d9e-ef5905697fd0	8f1fb163-d413-418f-9554-73382711b2d0	d3f4e8ea-0cbf-46c7-8603-d6250417c835	Red Series No. 7	James O'Brien	james.obrien@example.com	Red Series No. 7 caught my eye — what are the framing options? I'd love a float-mount in a dark timber frame.	\N	2026-07-28 03:46:49.403681+00	HANDLED	\N
167e632d-363e-45f8-a2ca-536a9302e1f7	d16f3ded-37d7-428e-a588-7d82474aede2	9a6517ac-f71b-43f8-83df-65042abd6fb6	Blue Mountains at Dusk	Emma Wilson	emma.wilson@example.com	Hi Jane, I love Blue Mountains at Dusk — is it still available? Would it suit a living room with warm neutral tones? Happy to arrange a viewing.	\N	2026-07-28 03:47:36.761098+00	NEW	\N
1b649c7e-8e79-434b-a14d-79bfc6ca96f5	d16f3ded-37d7-428e-a588-7d82474aede2	230e2f31-79d7-4557-9c2e-b48ee287ab0e	Morning Light, Kangaroo Valley	Thomas Chen	thomas.chen@example.com	I'm interested in Morning Light, Kangaroo Valley for a corporate office. Could you provide more details on framing options and delivery to Sydney?	\N	2026-07-28 03:47:36.761098+00	NEW	\N
fc262f03-f636-4da2-bcd0-8b425df48ad5	d16f3ded-37d7-428e-a588-7d82474aede2	e37689de-34de-435b-8370-253e1848aa6f	Coastal Study No. 3	Sarah Johnson	sarah.j@example.com	Is edition 1 of 5 still available? I collect small-format pastels and this one really speaks to me.	\N	2026-07-28 03:47:36.761098+00	HANDLED	\N
\.


--
-- Data for Name: inquiry_reply; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.inquiry_reply (id, tenant_id, inquiry_id, message, sent_at, sent_by_user_id) FROM stdin;
e4a22b21-8991-481d-840a-1bb3a19d1a0c	8f1fb163-d413-418f-9554-73382711b2d0	a59afc8a-adb0-41ce-9d9e-ef5905697fd0	Hi James, great choice! We can float-mount Red Series No. 7 in a dark Tasmanian oak frame — it really makes the reds pop. Total with framing would be approximately $480 extra. Let us know if you'd like to come in for a consultation.	2026-07-28 03:46:49.411388+00	71f1d92e-16c1-4b50-9bda-1c8a9cb2b102
a68b0445-1ab7-4bde-9954-0d89bc1ddf07	d16f3ded-37d7-428e-a588-7d82474aede2	fc262f03-f636-4da2-bcd0-8b425df48ad5	Hi Sarah, yes edition 1 of 5 is still available! It's an intimate little piece — 30×30cm. I can hold it for you for 48 hours if you'd like to commit. Shipping to most Australian metro areas is $45 flat. Let me know!	2026-07-28 03:47:36.769282+00	3400ab51-cf9b-4432-bf4b-9d4d56416340
\.


--
-- Data for Name: order; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."order" (id, tenant_id, stripe_session_id, stripe_payment_intent_id, buyer_email, buyer_name, status, fulfillment_type, total_cents, application_fee_cents, tracking_note, created_at, updated_at, iframer_job_id, iframer_job_error, email_sent_at, email_error, email_attempts, email_last_attempt_at, status_email_queued_at, status_email_error, status_email_attempts, status_email_last_attempt_at, email_failure_notified_at, refunded_amount_cents, refunded_at, stripe_refund_id) FROM stdin;
f02a5dcf-d138-4e9b-bcf7-341935cb103e	8f1fb163-d413-418f-9554-73382711b2d0	seed_cs_fw_001	seed_pi_fw_001	frances.murray@example.com	Frances Murray	FULFILLED	PICKUP	160000	8000	Collected in store 24 Jul 2026. Wrapped and ready.	2026-07-28 03:46:49.420048+00	2026-07-28 03:46:49.420048+00	\N	\N	2026-07-23 03:46:49.418+00	\N	0	\N	\N	\N	0	\N	\N	\N	\N	\N
a36f5edf-ce44-4e12-890c-6fbe605a619a	d16f3ded-37d7-428e-a588-7d82474aede2	seed_cs_jane_001	seed_pi_jane_001	david.miller@example.com	David Miller	FULFILLED	SHIP	550000	27500	Dispatched via Australia Post Express. Tracking: EX123456789AU	2026-07-28 03:47:36.776346+00	2026-07-28 03:47:36.776346+00	\N	\N	2026-07-25 03:47:36.775+00	\N	0	\N	\N	\N	0	\N	\N	\N	\N	\N
\.


--
-- Data for Name: order_item; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.order_item (id, order_id, artwork_id, tenant_id, quantity, price_cents, artwork_title, artwork_sku, created_at) FROM stdin;
fbc04645-62af-4cbf-9698-6bdcb5ad61b5	f02a5dcf-d138-4e9b-bcf7-341935cb103e	2986211d-1125-4ba6-81d0-6b113c6ffb24	8f1fb163-d413-418f-9554-73382711b2d0	1	160000	Still Life with Lemons	FW-003	2026-07-28 03:46:49.42683+00
7d3ab7de-4673-4afc-9840-a34579e5c754	a36f5edf-ce44-4e12-890c-6fbe605a619a	8f9d9ef3-8bef-43eb-ae55-6b401b13ac83	d16f3ded-37d7-428e-a588-7d82474aede2	1	550000	Sydney Harbour, Winter	JS-004	2026-07-28 03:47:36.784207+00
\.


--
-- Data for Name: rate_limit_event; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rate_limit_event (id, key, created_at) FROM stdin;
\.


--
-- Data for Name: represented_artist; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.represented_artist (id, tenant_id, name, bio, commission_pct, created_at) FROM stdin;
c61fd2ce-8781-4a37-9e02-073fc298d3cc	8f1fb163-d413-418f-9554-73382711b2d0	Michael Torres	Sydney-based abstract painter with 20 years of exhibition history across Australia and Europe.	25	2026-07-28 03:46:49.344016+00
\.


--
-- Data for Name: staff_invite; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.staff_invite (id, tenant_id, email, role, token, expires_at, accepted_at, created_at) FROM stdin;
\.


--
-- Data for Name: stripe_alert; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stripe_alert (id, stripe_event_id, event_type, customer_id, subscription_id, reason, dismissed_at, created_at, slack_post_failed) FROM stdin;
\.


--
-- Data for Name: tenant; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenant (id, type, business_name, slug, custom_domain, custom_domain_verified, storefront_enabled, logo_url, theme_color, about_text, stripe_account_id, iframer_account_id, created_at, updated_at, contact_email, stripe_customer_id, stripe_subscription_id, subscription_status, billing_exempt) FROM stdin;
8f1fb163-d413-418f-9554-73382711b2d0	FRAMER	Frame Works Sydney	frame-works-sydney	\N	f	t	\N	#1c1917	Custom framing and fine art gallery in Surry Hills. Representing over 40 Australian artists on consignment.	\N	\N	2026-07-18 06:19:01.974623+00	2026-07-18 06:19:01.974623+00	\N	\N	\N	\N	t
2a824086-e683-41a6-8099-fb191c95bde0	ARTIST	anokah	anokah	\N	f	t	\N	\N	\N	\N	\N	2026-07-18 08:18:48.799795+00	2026-07-18 08:18:48.799795+00	\N	\N	\N	\N	t
d16f3ded-37d7-428e-a588-7d82474aede2	ARTIST	Jane Smith Studio	jane-smith-studio	\N	f	t	\N	#b45309	Contemporary oil paintings celebrating light and the Australian landscape. Based in Melbourne, available for commissions.	\N	\N	2026-07-18 06:19:01.958591+00	2026-07-18 06:19:01.958591+00	\N	\N	\N	\N	t
\.


--
-- Data for Name: tenant_user; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenant_user (tenant_id, user_id, role) FROM stdin;
d16f3ded-37d7-428e-a588-7d82474aede2	3400ab51-cf9b-4432-bf4b-9d4d56416340	owner
8f1fb163-d413-418f-9554-73382711b2d0	71f1d92e-16c1-4b50-9bda-1c8a9cb2b102	owner
2a824086-e683-41a6-8099-fb191c95bde0	313de9b4-0baa-408f-9bb9-9184dbeb9e15	owner
\.


--
-- Name: app_user app_user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_email_unique UNIQUE (email);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: artwork_category_on_artwork artwork_category_on_artwork_artwork_id_category_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_category_on_artwork
    ADD CONSTRAINT artwork_category_on_artwork_artwork_id_category_id_pk PRIMARY KEY (artwork_id, category_id);


--
-- Name: artwork_category artwork_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_category
    ADD CONSTRAINT artwork_category_pkey PRIMARY KEY (id);


--
-- Name: artwork_image artwork_image_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_image
    ADD CONSTRAINT artwork_image_pkey PRIMARY KEY (id);


--
-- Name: artwork artwork_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork
    ADD CONSTRAINT artwork_pkey PRIMARY KEY (id);


--
-- Name: inquiry inquiry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry
    ADD CONSTRAINT inquiry_pkey PRIMARY KEY (id);


--
-- Name: inquiry_reply inquiry_reply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry_reply
    ADD CONSTRAINT inquiry_reply_pkey PRIMARY KEY (id);


--
-- Name: order_item order_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item
    ADD CONSTRAINT order_item_pkey PRIMARY KEY (id);


--
-- Name: order order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order"
    ADD CONSTRAINT order_pkey PRIMARY KEY (id);


--
-- Name: order order_stripe_session_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order"
    ADD CONSTRAINT order_stripe_session_id_unique UNIQUE (stripe_session_id);


--
-- Name: rate_limit_event rate_limit_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_event
    ADD CONSTRAINT rate_limit_event_pkey PRIMARY KEY (id);


--
-- Name: represented_artist represented_artist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.represented_artist
    ADD CONSTRAINT represented_artist_pkey PRIMARY KEY (id);


--
-- Name: staff_invite staff_invite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invite
    ADD CONSTRAINT staff_invite_pkey PRIMARY KEY (id);


--
-- Name: staff_invite staff_invite_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invite
    ADD CONSTRAINT staff_invite_token_unique UNIQUE (token);


--
-- Name: stripe_alert stripe_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_alert
    ADD CONSTRAINT stripe_alert_pkey PRIMARY KEY (id);


--
-- Name: stripe_alert stripe_alert_stripe_event_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_alert
    ADD CONSTRAINT stripe_alert_stripe_event_id_unique UNIQUE (stripe_event_id);


--
-- Name: tenant tenant_custom_domain_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_custom_domain_unique UNIQUE (custom_domain);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);


--
-- Name: tenant tenant_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_slug_unique UNIQUE (slug);


--
-- Name: tenant tenant_stripe_customer_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_stripe_customer_id_unique UNIQUE (stripe_customer_id);


--
-- Name: tenant tenant_stripe_subscription_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_stripe_subscription_id_unique UNIQUE (stripe_subscription_id);


--
-- Name: tenant_user tenant_user_tenant_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_user
    ADD CONSTRAINT tenant_user_tenant_id_user_id_pk PRIMARY KEY (tenant_id, user_id);


--
-- Name: artwork_sku_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artwork_sku_tenant_idx ON public.artwork USING btree (tenant_id, sku);


--
-- Name: rate_limit_event_key_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limit_event_key_created_at_idx ON public.rate_limit_event USING btree (key, created_at);


--
-- Name: stripe_alert_dismissed_at_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stripe_alert_dismissed_at_created_at_idx ON public.stripe_alert USING btree (dismissed_at, created_at);


--
-- Name: artwork_category_on_artwork artwork_category_on_artwork_artwork_id_artwork_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_category_on_artwork
    ADD CONSTRAINT artwork_category_on_artwork_artwork_id_artwork_id_fk FOREIGN KEY (artwork_id) REFERENCES public.artwork(id) ON DELETE CASCADE;


--
-- Name: artwork_category_on_artwork artwork_category_on_artwork_category_id_artwork_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_category_on_artwork
    ADD CONSTRAINT artwork_category_on_artwork_category_id_artwork_category_id_fk FOREIGN KEY (category_id) REFERENCES public.artwork_category(id) ON DELETE CASCADE;


--
-- Name: artwork_category artwork_category_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_category
    ADD CONSTRAINT artwork_category_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: artwork_image artwork_image_artwork_id_artwork_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_image
    ADD CONSTRAINT artwork_image_artwork_id_artwork_id_fk FOREIGN KEY (artwork_id) REFERENCES public.artwork(id) ON DELETE CASCADE;


--
-- Name: artwork_image artwork_image_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_image
    ADD CONSTRAINT artwork_image_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: artwork artwork_represented_artist_id_represented_artist_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork
    ADD CONSTRAINT artwork_represented_artist_id_represented_artist_id_fk FOREIGN KEY (represented_artist_id) REFERENCES public.represented_artist(id) ON DELETE SET NULL;


--
-- Name: artwork artwork_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork
    ADD CONSTRAINT artwork_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: inquiry inquiry_artwork_id_artwork_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry
    ADD CONSTRAINT inquiry_artwork_id_artwork_id_fk FOREIGN KEY (artwork_id) REFERENCES public.artwork(id);


--
-- Name: inquiry_reply inquiry_reply_inquiry_id_inquiry_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry_reply
    ADD CONSTRAINT inquiry_reply_inquiry_id_inquiry_id_fk FOREIGN KEY (inquiry_id) REFERENCES public.inquiry(id);


--
-- Name: inquiry_reply inquiry_reply_sent_by_user_id_app_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry_reply
    ADD CONSTRAINT inquiry_reply_sent_by_user_id_app_user_id_fk FOREIGN KEY (sent_by_user_id) REFERENCES public.app_user(id);


--
-- Name: inquiry_reply inquiry_reply_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry_reply
    ADD CONSTRAINT inquiry_reply_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: inquiry inquiry_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiry
    ADD CONSTRAINT inquiry_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: order_item order_item_artwork_id_artwork_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item
    ADD CONSTRAINT order_item_artwork_id_artwork_id_fk FOREIGN KEY (artwork_id) REFERENCES public.artwork(id);


--
-- Name: order_item order_item_order_id_order_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item
    ADD CONSTRAINT order_item_order_id_order_id_fk FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE;


--
-- Name: order_item order_item_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item
    ADD CONSTRAINT order_item_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: order order_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."order"
    ADD CONSTRAINT order_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);


--
-- Name: represented_artist represented_artist_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.represented_artist
    ADD CONSTRAINT represented_artist_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: staff_invite staff_invite_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invite
    ADD CONSTRAINT staff_invite_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: tenant_user tenant_user_tenant_id_tenant_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_user
    ADD CONSTRAINT tenant_user_tenant_id_tenant_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON DELETE CASCADE;


--
-- Name: tenant_user tenant_user_user_id_app_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_user
    ADD CONSTRAINT tenant_user_user_id_app_user_id_fk FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict TaltY1HGpspvl0I8ZydNNXannLijuBQxhDmBAVvMFQF3HcGWGZum6GK4vAg7z3o

