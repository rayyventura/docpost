/* eslint-disable @typescript-eslint/no-unused-vars */
import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb, schema } from './index.js';

const USER_1_ID = '00000000-0000-0000-0000-000000000001';
const USER_2_ID = '00000000-0000-0000-0000-000000000002';
const USER_3_ID = '00000000-0000-0000-0000-000000000003';
const USER_RAY_ID = '00000000-0000-0000-0000-000000000004';
const SEEDED_USER_IDS = [USER_1_ID, USER_2_ID, USER_3_ID, USER_RAY_ID];

type FolderRow = typeof schema.folders.$inferSelect;

async function insertFolderChain(
  db: ReturnType<typeof getDb>,
  binderId: string,
  parentId: string | null,
  names: string[],
): Promise<FolderRow[]> {
  const results: FolderRow[] = [];
  let currentParent = parentId;
  for (const name of names) {
    const [row] = await db
      .insert(schema.folders)
      .values({ binderId, parentFolderId: currentParent, name })
      .returning();
    results.push(row);
    currentParent = row.id;
  }
  return results;
}

async function insertFolders(
  db: ReturnType<typeof getDb>,
  binderId: string,
  parentId: string | null,
  names: string[],
): Promise<FolderRow[]> {
  return db
    .insert(schema.folders)
    .values(names.map((name) => ({ binderId, parentFolderId: parentId, name })))
    .returning();
}

// Seeds the team hierarchy used locally: teams, binders, folders, and sample documents.
// New accounts are granted access to these teams at registration.
// More granular permission access will be provided on demand in v2.
async function seed() {
  const db = getDb();
  console.log('Seeding platform database...');

  await db.delete(schema.documents);
  await db.delete(schema.folders);
  await db.delete(schema.binders);
  await db.delete(schema.teamMembers);
  await db.delete(schema.teams);

  // ── Teams ──────────────────────────────────────────────────────────
  const allTeams = await db
    .insert(schema.teams)
    .values([
      { name: 'Cardiology Trial', region: 'us-east-1', docpostEnabled: true },
      { name: 'Oncology Study', region: 'eu-west-1', docpostEnabled: true },
      { name: 'Neurology Research', region: 'ap-southeast-1', docpostEnabled: true },
      { name: 'Pulmonology Program', region: 'us-west-2', docpostEnabled: true },
      { name: 'Endocrinology Trial', region: 'eu-central-1', docpostEnabled: true },
      { name: 'Dermatology Study', region: 'us-east-1', docpostEnabled: true },
      { name: 'Pediatrics Research', region: 'ap-northeast-1', docpostEnabled: true },
      { name: 'Rheumatology Trial', region: 'eu-west-2', docpostEnabled: true },
      { name: 'Ophthalmology Study', region: 'us-west-1', docpostEnabled: true },
      { name: 'Gastroenterology Program', region: 'ap-south-1', docpostEnabled: true },
      { name: 'Internal Admin', region: 'us-east-1', docpostEnabled: false },
      { name: 'Archive Team', region: 'eu-west-1', docpostEnabled: false },
    ])
    .returning();

  const [
    cardiology, oncology, neurology, pulmonology, endocrinology,
    dermatology, pediatrics, rheumatology, ophthalmology, gastro,
    internalAdmin, archiveTeam,
  ] = allTeams;

  console.log(`Created ${allTeams.length} teams`);

  // Every existing seed account can use every team.
  // More granular permission access will be provided on demand in v2.
  const memberships = allTeams.flatMap((team) =>
    SEEDED_USER_IDS.map((userId) => ({ teamId: team.id, userId })),
  );
  await db.insert(schema.teamMembers).values(memberships);
  console.log(`Created ${memberships.length} memberships`);

  // ── Binders ────────────────────────────────────────────────────────
  const binders = await db
    .insert(schema.binders)
    .values([
      // Cardiology (2)
      { teamId: cardiology.id, name: 'Patient Records' },
      { teamId: cardiology.id, name: 'Trial Protocols' },
      // Oncology (3)
      { teamId: oncology.id, name: 'Clinical Data' },
      { teamId: oncology.id, name: 'Lab Reports' },
      { teamId: oncology.id, name: 'Treatment Plans' },
      // Neurology (2)
      { teamId: neurology.id, name: 'Imaging Studies' },
      { teamId: neurology.id, name: 'Research Notes' },
      // Pulmonology (3)
      { teamId: pulmonology.id, name: 'Spirometry Results' },
      { teamId: pulmonology.id, name: 'Bronchoscopy Records' },
      { teamId: pulmonology.id, name: 'Sleep Study Data' },
      // Endocrinology (2)
      { teamId: endocrinology.id, name: 'Hormone Panels' },
      { teamId: endocrinology.id, name: 'Diabetes Monitoring' },
      // Dermatology (2)
      { teamId: dermatology.id, name: 'Biopsy Reports' },
      { teamId: dermatology.id, name: 'Photo Documentation' },
      // Pediatrics (3)
      { teamId: pediatrics.id, name: 'Growth Charts' },
      { teamId: pediatrics.id, name: 'Vaccination Records' },
      { teamId: pediatrics.id, name: 'Developmental Assessments' },
      // Rheumatology (2)
      { teamId: rheumatology.id, name: 'Joint Imaging' },
      { teamId: rheumatology.id, name: 'Autoimmune Panels' },
      // Ophthalmology (2)
      { teamId: ophthalmology.id, name: 'Retinal Scans' },
      { teamId: ophthalmology.id, name: 'Visual Field Tests' },
      // Gastro (3)
      { teamId: gastro.id, name: 'Endoscopy Reports' },
      { teamId: gastro.id, name: 'Pathology Slides' },
      { teamId: gastro.id, name: 'Microbiome Analysis' },
    ])
    .returning();

  const b = (name: string) => binders.find((x) => x.name === name)!;
  console.log(`Created ${binders.length} binders`);

  let folderCount = 0;

  // ── Cardiology – Patient Records (deep) ────────────────────────────
  const cardPatient = b('Patient Records');
  const [intakeForms, progressNotes, dischargeSummaries] = await insertFolders(
    db, cardPatient.id, null, ['Intake Forms', 'Progress Notes', 'Discharge Summaries'],
  );
  // Intake Forms → 2024 Cohort → Site 101 → Screening → Visit 1..3
  const [cohort2024, cohort2025] = await insertFolders(db, cardPatient.id, intakeForms.id, ['2024 Cohort', '2025 Cohort']);
  const [site101, site102] = await insertFolders(db, cardPatient.id, cohort2024.id, ['Site 101', 'Site 102']);
  const [screening101] = await insertFolders(db, cardPatient.id, site101.id, ['Screening']);
  await insertFolders(db, cardPatient.id, screening101.id, ['Visit 1', 'Visit 2', 'Visit 3']);
  const [screening102] = await insertFolders(db, cardPatient.id, site102.id, ['Screening', 'Randomization']);
  await insertFolders(db, cardPatient.id, screening102.id, ['Visit 1', 'Visit 2']);
  // 2025 Cohort → Site 201 → Enrollment → Batch A/B
  const [site201] = await insertFolders(db, cardPatient.id, cohort2025.id, ['Site 201']);
  const [enrollment201] = await insertFolders(db, cardPatient.id, site201.id, ['Enrollment']);
  await insertFolders(db, cardPatient.id, enrollment201.id, ['Batch A', 'Batch B']);
  // Progress Notes → Weekly → Week 1..4
  const [weekly] = await insertFolders(db, cardPatient.id, progressNotes.id, ['Weekly']);
  await insertFolders(db, cardPatient.id, weekly.id, ['Week 1', 'Week 2', 'Week 3', 'Week 4']);
  folderCount += 27;

  // ── Cardiology – Trial Protocols (deep) ────────────────────────────
  const cardProtocol = b('Trial Protocols');
  const [phaseI, phaseII, phaseIII] = await insertFolders(db, cardProtocol.id, null, ['Phase I', 'Phase II', 'Phase III']);
  // Phase I → Dose Escalation → Low / Medium / High → Adverse Events
  const [doseEsc] = await insertFolders(db, cardProtocol.id, phaseI.id, ['Dose Escalation']);
  const [lowDose, medDose, highDose] = await insertFolders(db, cardProtocol.id, doseEsc.id, ['Low Dose', 'Medium Dose', 'High Dose']);
  await insertFolders(db, cardProtocol.id, lowDose.id, ['Adverse Events', 'Efficacy Data']);
  await insertFolders(db, cardProtocol.id, medDose.id, ['Adverse Events']);
  await insertFolders(db, cardProtocol.id, highDose.id, ['Adverse Events', 'Safety Review']);
  // Phase II → Arm A / Arm B
  await insertFolders(db, cardProtocol.id, phaseII.id, ['Arm A', 'Arm B', 'Placebo Control']);
  // Phase III → Interim Analysis → DSMB Reports
  const [interim] = await insertFolders(db, cardProtocol.id, phaseIII.id, ['Interim Analysis', 'Final Analysis']);
  await insertFolders(db, cardProtocol.id, interim.id, ['DSMB Reports', 'Efficacy Endpoints']);
  folderCount += 22;

  // ── Oncology – Clinical Data (deep) ────────────────────────────────
  const oncClinical = b('Clinical Data');
  const [baseline, followUp, survival] = await insertFolders(db, oncClinical.id, null, ['Baseline Assessments', 'Follow-up Data', 'Survival Analysis']);
  // Baseline → ECOG Scores → By Site → Site A..C
  const [ecog] = await insertFolders(db, oncClinical.id, baseline.id, ['ECOG Scores', 'Tumor Staging']);
  const [bySite] = await insertFolders(db, oncClinical.id, ecog.id, ['By Site']);
  await insertFolders(db, oncClinical.id, bySite.id, ['Site A', 'Site B', 'Site C']);
  // Follow-up → Month 3 → Labs / Imaging / Symptoms
  const [month3, month6, month12] = await insertFolders(db, oncClinical.id, followUp.id, ['Month 3', 'Month 6', 'Month 12']);
  await insertFolders(db, oncClinical.id, month3.id, ['Labs', 'Imaging', 'Symptoms']);
  await insertFolders(db, oncClinical.id, month6.id, ['Labs', 'Imaging']);
  // Survival → Kaplan-Meier → Subgroup
  const [km] = await insertFolders(db, oncClinical.id, survival.id, ['Kaplan-Meier']);
  await insertFolders(db, oncClinical.id, km.id, ['Subgroup A', 'Subgroup B']);
  folderCount += 23;

  // ── Oncology – Lab Reports ─────────────────────────────────────────
  const oncLab = b('Lab Reports');
  const [bloodWork, biopsies, genomic] = await insertFolders(db, oncLab.id, null, ['Blood Work', 'Biopsies', 'Genomic Analysis']);
  const [cbc] = await insertFolders(db, oncLab.id, bloodWork.id, ['CBC Results', 'CMP Results', 'Coagulation']);
  await insertFolders(db, oncLab.id, cbc.id, ['Flagged', 'Normal']);
  // Biopsies → Core Needle → Slides → H&E / IHC
  const [coreNeedle] = await insertFolders(db, oncLab.id, biopsies.id, ['Core Needle', 'Excisional']);
  const [slides] = await insertFolders(db, oncLab.id, coreNeedle.id, ['Slides']);
  await insertFolders(db, oncLab.id, slides.id, ['H&E Stain', 'IHC Stain']);
  // Genomic → NGS Panels → Mutations → Actionable / VUS
  const [ngs] = await insertFolders(db, oncLab.id, genomic.id, ['NGS Panels']);
  const [mutations] = await insertFolders(db, oncLab.id, ngs.id, ['Mutations']);
  await insertFolders(db, oncLab.id, mutations.id, ['Actionable', 'VUS']);
  folderCount += 19;

  // ── Oncology – Treatment Plans ─────────────────────────────────────
  const oncTreatment = b('Treatment Plans');
  const [chemo, radiation, immuno] = await insertFolders(db, oncTreatment.id, null, ['Chemotherapy', 'Radiation', 'Immunotherapy']);
  // Chemo → Regimen A → Cycle 1..4
  const [regimenA] = await insertFolders(db, oncTreatment.id, chemo.id, ['Regimen A', 'Regimen B']);
  await insertFolders(db, oncTreatment.id, regimenA.id, ['Cycle 1', 'Cycle 2', 'Cycle 3', 'Cycle 4']);
  // Radiation → Planning → Contours / Dose Maps
  const [rtPlanning] = await insertFolders(db, oncTreatment.id, radiation.id, ['Planning', 'Delivery Records']);
  await insertFolders(db, oncTreatment.id, rtPlanning.id, ['Contours', 'Dose Maps', 'QA Checks']);
  folderCount += 15;

  // ── Neurology – Imaging Studies (deep) ─────────────────────────────
  const neuroImaging = b('Imaging Studies');
  const [mri, ct, pet] = await insertFolders(db, neuroImaging.id, null, ['MRI Scans', 'CT Scans', 'PET Scans']);
  // MRI → Pre-treatment → T1 Weighted → Axial / Coronal / Sagittal
  const [mriPre, mriPost] = await insertFolders(db, neuroImaging.id, mri.id, ['Pre-treatment', 'Post-treatment']);
  const [t1] = await insertFolders(db, neuroImaging.id, mriPre.id, ['T1 Weighted', 'T2 Weighted', 'FLAIR']);
  await insertFolders(db, neuroImaging.id, t1.id, ['Axial', 'Coronal', 'Sagittal']);
  // Post-treatment → 3 Month / 6 Month
  await insertFolders(db, neuroImaging.id, mriPost.id, ['3 Month', '6 Month', '12 Month']);
  // CT → Contrast / Non-contrast
  await insertFolders(db, neuroImaging.id, ct.id, ['Contrast', 'Non-contrast']);
  folderCount += 17;

  // ── Neurology – Research Notes ─────────────────────────────────────
  const neuroResearch = b('Research Notes');
  const [litReview, expLogs] = await insertFolders(db, neuroResearch.id, null, ['Literature Reviews', 'Experiment Logs']);
  const [synaptic] = await insertFolders(db, neuroResearch.id, litReview.id, ['Synaptic Plasticity', 'Neurodegeneration']);
  await insertFolders(db, neuroResearch.id, synaptic.id, ['LTP Studies', 'LTD Studies']);
  // Experiment Logs → EEG → Raw / Processed → Epochs
  const [eeg] = await insertFolders(db, neuroResearch.id, expLogs.id, ['EEG', 'fMRI']);
  const [raw] = await insertFolders(db, neuroResearch.id, eeg.id, ['Raw Data', 'Processed']);
  await insertFolders(db, neuroResearch.id, raw.id, ['Session 1', 'Session 2', 'Session 3']);
  folderCount += 14;

  // ── Pulmonology – Spirometry Results (deep) ────────────────────────
  const pulmoSpiro = b('Spirometry Results');
  const [preBD, postBD] = await insertFolders(db, pulmoSpiro.id, null, ['Pre-Bronchodilator', 'Post-Bronchodilator', 'Methacholine Challenge']);
  // Pre-BD → FEV1 Trends → Quarterly → Q1..Q4
  const [fev1] = await insertFolders(db, pulmoSpiro.id, preBD.id, ['FEV1 Trends', 'FVC Trends']);
  const [quarterly] = await insertFolders(db, pulmoSpiro.id, fev1.id, ['Quarterly']);
  await insertFolders(db, pulmoSpiro.id, quarterly.id, ['Q1 2025', 'Q2 2025', 'Q3 2025', 'Q4 2025']);
  folderCount += 11;

  // ── Pulmonology – Bronchoscopy Records ─────────────────────────────
  const pulmoBronch = b('Bronchoscopy Records');
  const [diagnostic, therapeutic] = await insertFolders(db, pulmoBronch.id, null, ['Diagnostic', 'Therapeutic']);
  const [bal] = await insertFolders(db, pulmoBronch.id, diagnostic.id, ['BAL Samples', 'Biopsy Samples']);
  await insertFolders(db, pulmoBronch.id, bal.id, ['Cytology', 'Culture']);
  // Therapeutic → Stent Placement → Follow-up → Week 1 / Week 4
  const [stent] = await insertFolders(db, pulmoBronch.id, therapeutic.id, ['Stent Placement']);
  const [stentFU] = await insertFolders(db, pulmoBronch.id, stent.id, ['Follow-up']);
  await insertFolders(db, pulmoBronch.id, stentFU.id, ['Week 1', 'Week 4']);
  folderCount += 11;

  // ── Pulmonology – Sleep Study Data ─────────────────────────────────
  const pulmoSleep = b('Sleep Study Data');
  await insertFolders(db, pulmoSleep.id, null, ['Polysomnography', 'CPAP Titration', 'MSLT']);
  folderCount += 3;

  // ── Endocrinology – Hormone Panels (deep) ──────────────────────────
  const endoHormone = b('Hormone Panels');
  const [thyroid, adrenal, pituitary] = await insertFolders(db, endoHormone.id, null, ['Thyroid', 'Adrenal', 'Pituitary']);
  // Thyroid → TSH / T3 / T4 → Abnormal → Hyper / Hypo
  const [tsh] = await insertFolders(db, endoHormone.id, thyroid.id, ['TSH', 'Free T3', 'Free T4']);
  const [abnormal] = await insertFolders(db, endoHormone.id, tsh.id, ['Abnormal']);
  await insertFolders(db, endoHormone.id, abnormal.id, ['Hyperthyroid', 'Hypothyroid']);
  // Adrenal → Cortisol → AM / PM → Suppression Tests
  const [cortisol] = await insertFolders(db, endoHormone.id, adrenal.id, ['Cortisol', 'Aldosterone']);
  const [amCortisol] = await insertFolders(db, endoHormone.id, cortisol.id, ['AM Draw', 'PM Draw']);
  await insertFolders(db, endoHormone.id, amCortisol.id, ['Suppression Tests']);
  folderCount += 14;

  // ── Endocrinology – Diabetes Monitoring ────────────────────────────
  const endoDiabetes = b('Diabetes Monitoring');
  const [hba1c, cgm] = await insertFolders(db, endoDiabetes.id, null, ['HbA1c Tracking', 'CGM Data', 'Insulin Logs']);
  // CGM → Daily Exports → 2025 → Jan..Mar
  const [cgmDaily] = await insertFolders(db, endoDiabetes.id, cgm.id, ['Daily Exports']);
  const [cgm2025] = await insertFolders(db, endoDiabetes.id, cgmDaily.id, ['2025']);
  await insertFolders(db, endoDiabetes.id, cgm2025.id, ['January', 'February', 'March']);
  folderCount += 9;

  // ── Dermatology – Biopsy Reports (deep) ────────────────────────────
  const dermBiopsy = b('Biopsy Reports');
  const [shave, punch, excision] = await insertFolders(db, dermBiopsy.id, null, ['Shave Biopsy', 'Punch Biopsy', 'Excisional Biopsy']);
  // Punch → Melanocytic → Atypical Nevi → Mild / Moderate / Severe
  const [melanocytic] = await insertFolders(db, dermBiopsy.id, punch.id, ['Melanocytic', 'Non-melanocytic']);
  const [atypical] = await insertFolders(db, dermBiopsy.id, melanocytic.id, ['Atypical Nevi']);
  await insertFolders(db, dermBiopsy.id, atypical.id, ['Mild Atypia', 'Moderate Atypia', 'Severe Atypia']);
  folderCount += 9;

  // ── Dermatology – Photo Documentation ──────────────────────────────
  const dermPhoto = b('Photo Documentation');
  const [clinical, dermo] = await insertFolders(db, dermPhoto.id, null, ['Clinical Photos', 'Dermoscopy', 'UV Photography']);
  // Clinical → Body Region → Head & Neck → Lesion Tracking → Baseline / Month 3
  const [headNeck] = await insertFolders(db, dermPhoto.id, clinical.id, ['Head & Neck', 'Trunk', 'Extremities']);
  const [lesionTrack] = await insertFolders(db, dermPhoto.id, headNeck.id, ['Lesion Tracking']);
  await insertFolders(db, dermPhoto.id, lesionTrack.id, ['Baseline', 'Month 3', 'Month 6']);
  folderCount += 11;

  // ── Pediatrics – Growth Charts ─────────────────────────────────────
  const pedGrowth = b('Growth Charts');
  const [infant, child, adolescent] = await insertFolders(db, pedGrowth.id, null, ['Infant (0-2y)', 'Child (2-12y)', 'Adolescent (12-18y)']);
  // Infant → Weight-for-Age → Percentile Curves → CDC / WHO
  const [wfa] = await insertFolders(db, pedGrowth.id, infant.id, ['Weight-for-Age', 'Length-for-Age', 'Head Circumference']);
  const [percentile] = await insertFolders(db, pedGrowth.id, wfa.id, ['Percentile Curves']);
  await insertFolders(db, pedGrowth.id, percentile.id, ['CDC Standards', 'WHO Standards']);
  folderCount += 9;

  // ── Pediatrics – Vaccination Records ───────────────────────────────
  const pedVax = b('Vaccination Records');
  const [routine, catchUp] = await insertFolders(db, pedVax.id, null, ['Routine Schedule', 'Catch-up Schedule', 'Travel Vaccines']);
  // Routine → By Age → 2 Months → DTaP / IPV / Hib
  const [byAge] = await insertFolders(db, pedVax.id, routine.id, ['By Age']);
  const [twoMonths] = await insertFolders(db, pedVax.id, byAge.id, ['2 Months', '4 Months', '6 Months', '12 Months']);
  await insertFolders(db, pedVax.id, twoMonths.id, ['DTaP', 'IPV', 'Hib', 'PCV13']);
  folderCount += 12;

  // ── Pediatrics – Developmental Assessments ─────────────────────────
  const pedDev = b('Developmental Assessments');
  await insertFolders(db, pedDev.id, null, ['ASQ Screenings', 'M-CHAT', 'Bayley Scales']);
  folderCount += 3;

  // ── Rheumatology – Joint Imaging ───────────────────────────────────
  const rheuJoint = b('Joint Imaging');
  const [xray, ultrasound] = await insertFolders(db, rheuJoint.id, null, ['X-Ray', 'Ultrasound', 'MRI']);
  // X-Ray → Hands → Baseline → Left / Right
  const [hands] = await insertFolders(db, rheuJoint.id, xray.id, ['Hands', 'Feet', 'Knees', 'Spine']);
  const [handsBaseline] = await insertFolders(db, rheuJoint.id, hands.id, ['Baseline', '6 Month', '12 Month']);
  await insertFolders(db, rheuJoint.id, handsBaseline.id, ['Left', 'Right']);
  folderCount += 12;

  // ── Rheumatology – Autoimmune Panels ───────────────────────────────
  const rheuAuto = b('Autoimmune Panels');
  const [ana, rf] = await insertFolders(db, rheuAuto.id, null, ['ANA Panel', 'Rheumatoid Factor', 'Anti-CCP', 'Complement Levels']);
  // ANA → Patterns → Homogeneous / Speckled / Nucleolar
  const [patterns] = await insertFolders(db, rheuAuto.id, ana.id, ['Patterns', 'Titers']);
  await insertFolders(db, rheuAuto.id, patterns.id, ['Homogeneous', 'Speckled', 'Nucleolar', 'Centromere']);
  folderCount += 10;

  // ── Ophthalmology – Retinal Scans ──────────────────────────────────
  const ophRetinal = b('Retinal Scans');
  const [oct, fundus] = await insertFolders(db, ophRetinal.id, null, ['OCT', 'Fundus Photography', 'Fluorescein Angiography']);
  // OCT → Macula → OD / OS → Thickness Maps
  const [macula] = await insertFolders(db, ophRetinal.id, oct.id, ['Macula', 'Optic Nerve']);
  const [od] = await insertFolders(db, ophRetinal.id, macula.id, ['OD (Right)', 'OS (Left)']);
  await insertFolders(db, ophRetinal.id, od.id, ['Thickness Maps', 'RNFL Analysis']);
  folderCount += 10;

  // ── Ophthalmology – Visual Field Tests ─────────────────────────────
  const ophVF = b('Visual Field Tests');
  await insertFolders(db, ophVF.id, null, ['Humphrey 24-2', 'Humphrey 10-2', 'Goldmann']);
  folderCount += 3;

  // ── Gastro – Endoscopy Reports (deep) ──────────────────────────────
  const gastroEndo = b('Endoscopy Reports');
  const [egd, colonoscopy, ercp] = await insertFolders(db, gastroEndo.id, null, ['EGD', 'Colonoscopy', 'ERCP']);
  // EGD → Esophageal → Barrett Surveillance → Prague Classification → Short / Long Segment
  const [esophageal] = await insertFolders(db, gastroEndo.id, egd.id, ['Esophageal', 'Gastric', 'Duodenal']);
  const [barrett] = await insertFolders(db, gastroEndo.id, esophageal.id, ['Barrett Surveillance']);
  const [prague] = await insertFolders(db, gastroEndo.id, barrett.id, ['Prague Classification']);
  await insertFolders(db, gastroEndo.id, prague.id, ['Short Segment', 'Long Segment']);
  // Colonoscopy → Polyp Registry → By Location → Ascending / Transverse / Descending
  const [polypReg] = await insertFolders(db, gastroEndo.id, colonoscopy.id, ['Polyp Registry', 'Quality Metrics']);
  const [byLocation] = await insertFolders(db, gastroEndo.id, polypReg.id, ['By Location']);
  await insertFolders(db, gastroEndo.id, byLocation.id, ['Ascending', 'Transverse', 'Descending', 'Sigmoid']);
  folderCount += 18;

  // ── Gastro – Pathology Slides ──────────────────────────────────────
  const gastroPath = b('Pathology Slides');
  const [gi, liver] = await insertFolders(db, gastroPath.id, null, ['GI Tract', 'Liver', 'Pancreas']);
  const [celiac] = await insertFolders(db, gastroPath.id, gi.id, ['Celiac Workup', 'IBD Monitoring']);
  await insertFolders(db, gastroPath.id, celiac.id, ['Marsh Classification', 'Serology Correlation']);
  folderCount += 7;

  // ── Gastro – Microbiome Analysis ───────────────────────────────────
  const gastroMicro = b('Microbiome Analysis');
  const [stool16s] = await insertFolders(db, gastroMicro.id, null, ['16S rRNA', 'Shotgun Metagenomics', 'Metabolomics']);
  const [taxonomy] = await insertFolders(db, gastroMicro.id, stool16s.id, ['Taxonomy Reports']);
  await insertFolders(db, gastroMicro.id, taxonomy.id, ['Phylum Level', 'Genus Level', 'Species Level']);
  folderCount += 7;

  console.log(`Created ${folderCount} folders total`);

  // ── Seed documents ─────────────────────────────────────────────────
  await db.insert(schema.documents).values([
    {
      binderId: cardPatient.id,
      folderId: progressNotes.id,
      name: 'Patient-001-Visit-3.pdf',
      sizeBytes: BigInt(245760),
      contentType: 'application/pdf',
      checksumSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      uploadedByUserId: USER_1_ID,
    },
    {
      binderId: cardPatient.id,
      folderId: null,
      name: 'Study-Overview.docx',
      sizeBytes: BigInt(102400),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      checksumSha256: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      uploadedByUserId: USER_1_ID,
    },
    {
      binderId: oncClinical.id,
      folderId: baseline.id,
      name: 'Cohort-A-Baseline.xlsx',
      sizeBytes: BigInt(512000),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      checksumSha256: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      uploadedByUserId: USER_2_ID,
    },
    {
      binderId: neuroImaging.id,
      folderId: mriPre.id,
      name: 'Patient-042-MRI.png',
      sizeBytes: BigInt(2097152),
      contentType: 'image/png',
      checksumSha256: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
      uploadedByUserId: USER_1_ID,
    },
  ]);

  console.log('Created 4 seed documents');
  console.log('Seed complete!');

  await closeDb();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
