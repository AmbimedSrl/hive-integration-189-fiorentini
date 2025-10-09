/* ------------------------------------------------------------------------- */
/*  PARAM                                                                    */
/* ------------------------------------------------------------------------- */
SET @company_id = 189;           -- <-- company you want to extract (use this when testing locally)
-- SET @company_id = 132;           -- <-- sede test
-- CF: 

/* ------------------------------------------------------------------------- */
/*  CTE → pick only the most-recent examination done by every employee       */
/* ------------------------------------------------------------------------- */
WITH latest_exam AS (
    SELECT  e.*,
            ROW_NUMBER() OVER (PARTITION BY a.patient_id
                               ORDER BY e.start_date DESC) AS rn
    FROM        examinations         e
    INNER JOIN  assumptions          a  ON a.id       = e.assumption_id
    INNER JOIN  offices              o  ON o.id       = a.office_id
    WHERE       o.company_id = @company_id  AND e.deleted_at is NULL
)

/* ------------------------------------------------------------------------- */
/*  FINAL SELECT                                                             */
/* ------------------------------------------------------------------------- */
SELECT
	/*  0A Last Name									  */  p.surname AS last_name,
	/*  0B First Name									  */  p.name AS first_name,
    /*  1  Codice fiscale                                 */  p.fiscal_code                                      AS fiscal_code,
    /*  2  Mansione                                       */  d.description                                      AS mansione,
    /*  3  Tipologia                                      */  le.description                                     AS tipologia,
    /*  4  Periodicità visita                             */  d.base_periodicity                                 AS base_periodicity,

    /*  5  Fattori di rischio                             */
    GROUP_CONCAT(DISTINCT r.description
                 ORDER BY r.description SEPARATOR ', ')    AS risk_factors,

    /*  6  Accertamenti integrativi                       */
    GROUP_CONCAT(DISTINCT t.description
                 ORDER BY t.description SEPARATOR ', ')    AS integrative_tests,

    /*  7  Giudizio di idoneità                           */  le.result                                         AS result,
    /*  8  Prescrizioni / limitazioni                     */  le.prescription_to_company                        AS prescriptions,
    /*  9  Data ultima visita                             */  CONVERT_TZ(le.start_date, 'UTC', 'Europe/Rome')	AS last_visit_date,
    
    /* 10  Scadenza idoneità  */
	CASE
	  WHEN le.expiration_date IS NULL
	     OR le.expiration_date = '0000-00-00'
	     OR le.expiration_date = '0000-00-00 00:00:00'
	  THEN (
	     SELECT e2.expiration_date
	     FROM examinations e2
	     JOIN assumptions  a2 ON a2.id = e2.assumption_id
	     WHERE a2.patient_id = a.patient_id
	       AND e2.start_date < le.start_date
	       AND e2.no_show = 0
	       AND e2.expiration_date IS NOT NULL
	       AND e2.expiration_date NOT IN ('0000-00-00', '0000-00-00 00:00:00')
	     ORDER BY e2.start_date DESC, e2.id DESC
	     LIMIT 1
	  )
	  ELSE le.expiration_date
	END AS expiration_date,

    /* 11a / 11b  (immunological coverage – not tracked)  */  NULL                                              AS immuno_judgement,
                                                              NULL                                              AS immuno_expiration,

    /* 12  Medico Competente                              */  CONCAT(u.name, ' ', u.surname)                    AS medico_competente,

    /* 13  Trasmissione al lavoratore  */
	CASE
	  WHEN le.transmission_date IS NULL
	     OR le.transmission_date = '0000-00-00'
	     OR le.transmission_date = '0000-00-00 00:00:00'
	  THEN (
	     SELECT e2.transmission_date
	     FROM examinations e2
	     JOIN assumptions  a2 ON a2.id = e2.assumption_id
	     WHERE a2.patient_id = a.patient_id
	       AND e2.start_date < le.start_date
	       AND e2.no_show = 0
	       AND e2.transmission_date IS NOT NULL
	       AND e2.transmission_date NOT IN ('0000-00-00', '0000-00-00 00:00:00')
	     ORDER BY e2.start_date DESC, e2.id DESC
	     LIMIT 1
	  )
	  ELSE le.transmission_date
	END AS transmission_to_worker,

    /* 14  Trasmissione al datore di lavoro  */
	CASE
	  WHEN le.transmission_date IS NULL
	     OR le.transmission_date = '0000-00-00'
	     OR le.transmission_date = '0000-00-00 00:00:00'
	  THEN (
	     SELECT e2.transmission_date
	     FROM examinations e2
	     JOIN assumptions  a2 ON a2.id = e2.assumption_id
	     WHERE a2.patient_id = a.patient_id
	       AND e2.start_date < le.start_date
	       AND e2.no_show = 0
	       AND e2.transmission_date IS NOT NULL
	       AND e2.transmission_date NOT IN ('0000-00-00', '0000-00-00 00:00:00')
	     ORDER BY e2.start_date DESC, e2.id DESC
	     LIMIT 1
	  )
	  ELSE le.transmission_date
	END AS transmission_to_employer,

    /* 15  Data giudizio  */
	CASE
	  WHEN le.result_file_date IS NULL
	     OR le.result_file_date = '0000-00-00'
	     OR le.result_file_date = '0000-00-00 00:00:00'
	  THEN (
	     SELECT e2.result_file_date
	     FROM examinations e2
	     JOIN assumptions  a2 ON a2.id = e2.assumption_id
	     WHERE a2.patient_id = a.patient_id
	       AND e2.start_date < le.start_date
	       AND e2.no_show = 0
	       AND e2.result_file_date IS NOT NULL
	       AND e2.result_file_date NOT IN ('0000-00-00', '0000-00-00 00:00:00')
	     ORDER BY e2.start_date DESC, e2.id DESC
	     LIMIT 1
	  )
	  ELSE le.result_file_date
	END AS judgement_date,

    /* 16  Nome azienda (NEW)                             */  c.business_name                                   AS company_name,
    /* 17  Sede / filiale (NEW)                           */  o.name                                            AS office_location

FROM      latest_exam          le
JOIN      assumptions          a   ON a.id        = le.assumption_id
JOIN      patients             p   ON p.id        = a.patient_id
LEFT JOIN duties               d   ON d.id        = a.duty_id
LEFT JOIN users                u   ON u.id        = le.user_id

/* join office + company so we can expose their fields */
LEFT JOIN offices              o   ON o.id        = a.office_id
LEFT JOIN companies            c   ON c.id        = o.company_id

/* ---------- risks linked to the duty ------------------------------------ */
LEFT JOIN duty_has_risk        dr  ON dr.duty_id  = d.id
LEFT JOIN risks                r   ON r.id        = dr.risk_id

/* ---------- integrative tests actually executed ------------------------- */
LEFT JOIN examination_details  ed  ON ed.examination_id = le.id
LEFT JOIN tests                t   ON t.id              = ed.test_id

/* ---------- keep only the latest exam per employee ------------------------ */
WHERE     le.rn = 1

/* ---------- only active assumptions -------------------------------------- */
AND       a.end_date IS NULL 
-- AND       p.fiscal_code IN ('BNCLCU80A01F205T', 'BNCNNA80A41H501R', 'RSSGNN85A01M208I')
GROUP BY  p.id
ORDER BY  p.surname;

/* ------------------------------------------------------------------------- */
/*  If you want a richer “office_location” value, replace ‘o.name’ in the    *
 *  SELECT list with something like:                                         *
 *      CONCAT_WS(', ', o.address, o.zipcode, o.foreign_office_city)         *
 * ------------------------------------------------------------------------- */
