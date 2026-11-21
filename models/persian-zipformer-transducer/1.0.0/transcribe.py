import os
import sys
import argparse
import time
import re
import soundfile as sf
import sherpa_onnx

class PersianPostProcessor:
    """
    Comprehensive Persian Typography & Phonological Post-Processor for ASR transcripts.
    1. Handles Half-Spaces (ZWNJ / نیم‌فاصله) for prefixes (می/نمی), suffixes (ها/تر/ترین), silent 'h'.
    2. Resolves Colloquial Phonological Elisions (حذف و تضعیف واج‌ها در گفتار محاوره‌ای)
       via Persian Phonetic Key matching against standard lexicon (e.g. تمی کار -> تعمیرکار, آب گرم کن -> آب‌گرم‌کن).
    """
    def __init__(self):
        self.ZWNJ = '\u200c'
        
        # 1. Typography & Affixes
        self.colloquial_amadan = {'ام', 'ای', 'اد', 'ایم', 'ان'}
        self.non_verbs_mi = {
            'میوه', 'میوه‌ها', 'میوه‌های', 'میراث', 'میزان', 'میخ', 'میهن', 'میلاد', 'میز', 
            'میدان', 'میدان‌ها', 'میکروب', 'میلیون', 'میلیارد', 'مینو', 'میگون', 'میثم', 
            'میعاد', 'میش', 'میخانه', 'مینا', 'میبد', 'مینی', 'نمیم', 'نمین'
        }
        self.mi_space = re.compile(r'\b(ن?می)\s+([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی]+)\b')
        self.mi_attached = re.compile(r'\b(ن?می)([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی]{2,})\b')
        self.ha_attached = re.compile(r'([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(های(?:م|ت|ش|مان|تان|شان|ی)?|ها)\b')
        self.ha_space = re.compile(r'([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی]+)\s+(های(?:م|ت|ش|مان|تان|شان|ی)?|ها)\b')
        self.silent_h_suffix = re.compile(r'([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(ای|ام|ات|اش|اید|اند|ی)\b')
        self.tar_suffix = re.compile(r'([آابپتثجچحخدذرزژسشصضطظعغفقکگلمنو]ه)(تر|ترین)\b')

        # 2. Phonological Lexicon (Standard Persian Compound Nouns, Occupations, Common Words)
        self.standard_lexicon = [
            'تعمیرکار', 'تعمیرگاه', 'خدمتکار', 'امانتدار', 'صندوقدار', 'حسابدار',
            'آرایشگر', 'تراشکار', 'جوشکار', 'برق‌کار', 'سیم‌کش', 'لوله‌کش',
            'مهماندار', 'نگهبان', 'پستچی', 'خیاط', 'نقاش', 'عکاس', 'فیلمبردار', 'خبرنگار',
            'آب‌گرم‌کن', 'دستکش', 'دستگیره', 'جاروبرقی', 'ماشین‌لباسشویی',
            'یخچال‌فریزر', 'کولرگازی', 'ماشین‌ظرفشویی', 'تلویزیون',
            'شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه',
            'بیمارستان', 'دانشگاه', 'وزارتخانه', 'کتابخانه', 'داروخانه', 'سردخانه',
            'آزمایشگاه', 'پژوهشگاه', 'فرودگاه', 'پاسگاه', 'ایستگاه',
            'خوش‌آمد', 'فوق‌العاده', 'بین‌الملل', 'گفت‌وگو', 'جست‌وجو',
            'پیش‌بینی', 'اندازه‌گیری', 'منحصربه‌فرد', 'دست‌کم', 'یک‌دست'
        ]
        
        # Build Phonetic Index
        self.phonetic_index = {}
        for word in self.standard_lexicon:
            key = self._phonetic_key(word)
            self.phonetic_index[key] = word

    def _phonetic_key(self, w: str) -> str:
        """Calculates invariant phonetic representation reflecting colloquial Persian reductions."""
        w = w.replace('ي', 'ی').replace('ك', 'ک')
        w = re.sub(r'[\u200c\s]+', '', w)
        w = re.sub(r'[عءئ]', '', w)              # Silent glottal stops
        w = re.sub(r'ر(?=[کگ])', '', w)           # Flap /r/ elision before velars (e.g. تعمیرکار -> تمیکار)
        w = re.sub(r'[تد](?=[گکپتبسشچ])', '', w)  # Dental stop elision in consonant clusters (e.g. دستکش -> دس‌کش)
        w = re.sub(r'ه(?=ا)', '', w)              # Silent 'h' before vowels
        return w

    def _apply_phonological_lexicon(self, text: str) -> str:
        words = text.split()
        i = 0
        res = []
        n = len(words)
        while i < n:
            # 3-gram match (e.g. آب گرم کن -> آب‌گرم‌کن)
            if i + 2 < n:
                tri = ' '.join(words[i:i+3])
                k3 = self._phonetic_key(tri)
                if k3 in self.phonetic_index:
                    res.append(self.phonetic_index[k3])
                    i += 3
                    continue
            # 2-gram match (e.g. تمی کار -> تعمیرکار, دس کش -> دستکش)
            if i + 1 < n:
                bi = ' '.join(words[i:i+2])
                k2 = self._phonetic_key(bi)
                if k2 in self.phonetic_index:
                    res.append(self.phonetic_index[k2])
                    i += 2
                    continue
            # 1-gram match (e.g. تمیکار -> تعمیرکار, چارشنبه -> چهارشنبه)
            k1 = self._phonetic_key(words[i])
            if k1 in self.phonetic_index:
                res.append(self.phonetic_index[k1])
                i += 1
                continue
            
            res.append(words[i])
            i += 1
        return ' '.join(res)

    def process(self, text: str) -> str:
        ZWNJ = self.ZWNJ
        text = text.replace('ي', 'ی').replace('ك', 'ک')
        
        # 1. Phonological & Compound Lexicon Correction
        text = self._apply_phonological_lexicon(text)
        
        # 2. Verb prefixes (می / نمی) - both attached and with space
        def repl_attached(m):
            word = m.group(0)
            prefix = m.group(1)
            stem = m.group(2)
            if word in self.non_verbs_mi or stem in self.non_verbs_mi:
                return word
            if stem in self.colloquial_amadan:
                return word  # Keep natural colloquial 'میاد', 'میام', 'میان', 'نمیاد'
            if stem.startswith('آمد') or stem.startswith('آید'):
                pass
            elif stem.startswith('امد'):
                stem = 'آمد' + stem[3:]
            elif stem.startswith('اید'):
                stem = 'آید' + stem[3:]
            return f"{prefix}{ZWNJ}{stem}"

        text = self.mi_attached.sub(repl_attached, text)

        def fix_mi_space(match):
            prefix, stem = match.group(1), match.group(2)
            if stem in {'ان', 'وه', 'ز', 'هن', 'راث', 'لاد', 'خ'}:
                return match.group(0)
            if stem in self.colloquial_amadan:
                return f"{prefix}{stem}"  # 'می اد' -> 'میاد'
            if stem == 'امد': stem = 'آمد'
            elif stem == 'اید': stem = 'آید'
            return f"{prefix}{ZWNJ}{stem}"
        
        text = self.mi_space.sub(fix_mi_space, text)
        
        # 3. Suffixes
        text = self.ha_attached.sub(r'\g<1>' + ZWNJ + r'\g<2>', text)
        text = self.ha_space.sub(r'\g<1>' + ZWNJ + r'\g<2>', text)

        # Protect words ending in تهای / شتهای / ستای (like انتهای, اشتهای, روستای)
        def repl_silent_h(m):
            w = m.group(0)
            if w.endswith('تهای') or w.endswith('شتهای') or w.endswith('ستای') or w in {'انتهای', 'اشتهای', 'منتهای', 'روستای'}:
                return w
            return f"{m.group(1)}{ZWNJ}{m.group(2)}"

        text = self.silent_h_suffix.sub(repl_silent_h, text)
        text = self.tar_suffix.sub(r'\g<1>' + ZWNJ + r'\g<2>', text)
        
        # 4. Clean consecutive spaces and ZWNJs
        text = re.sub(rf'{ZWNJ}+', ZWNJ, text)
        text = re.sub(rf'\s*{ZWNJ}\s*', ZWNJ, text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text


def transcribe(audio_path, use_int8=True, model_dir=None, num_threads=4):
    if model_dir is None:
        model_dir = os.path.dirname(os.path.abspath(__file__))
    
    enc_name = 'encoder.int8.onnx' if use_int8 else 'encoder.onnx'
    dec_name = 'decoder.int8.onnx' if use_int8 else 'decoder.onnx'
    join_name = 'joiner.int8.onnx' if use_int8 else 'joiner.onnx'
    
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(model_dir, enc_name),
        decoder=os.path.join(model_dir, dec_name),
        joiner=os.path.join(model_dir, join_name),
        tokens=os.path.join(model_dir, 'tokens.txt'),
        num_threads=num_threads,
        sample_rate=16000,
        feature_dim=80,
        decoding_method='modified_beam_search',
        max_active_paths=4,
    )
    
    samples, sr = sf.read(audio_path)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    
    if sr != 16000:
        import numpy as np
        target_len = int(len(samples) * 16000 / sr)
        samples = np.interp(
            np.linspace(0, len(samples), target_len, endpoint=False),
            np.arange(len(samples)),
            samples
        ).astype(np.float32)
        sr = 16000

    stream = rec.create_stream()
    stream.accept_waveform(sr, samples)
    rec.decode_stream(stream)
    
    raw_text = stream.result.text
    clean_text = PersianPostProcessor().process(raw_text)
    return raw_text, clean_text

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Persian Zipformer-Transducer ASR Inference')
    parser.add_argument('--audio', type=str, default='sample.wav', help='Path to audio file (wav, flac, ogg)')
    parser.add_argument('--fp32', action='store_true', help='Use FP32 models instead of INT8')
    parser.add_argument('--threads', type=int, default=4, help='Number of CPU threads')
    args = parser.parse_args()
    
    if not os.path.exists(args.audio):
        print(f"Error: audio file '{args.audio}' not found.")
        sys.exit(1)
        
    print(f"Transcribing '{args.audio}' (Mode: {'FP32' if args.fp32 else 'INT8 Quantized'})...")
    raw, clean = transcribe(args.audio, use_int8=not args.fp32, num_threads=args.threads)
    print("\\n[Raw Output]:")
    print(raw)
    print("\\n[Clean Persian Output (with ZWNJ / نیم‌فاصله)]:")
    print(clean)
