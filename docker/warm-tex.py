"""Cache the shipped document renderers at image build time; failures fail the build."""
import subprocess
import tempfile
from pathlib import Path
from dashboard import resume_layout
from dashboard.documents import version_tex
from dashboard.resume import cover_letter_pdf

with tempfile.TemporaryDirectory() as directory:
    target = Path(directory)
    sources = [version_tex({'format':'text','text':'Fixture résumé with a sample record.'})]
    for size in (10, 11, 12):
        for template in ('classic', 'compact'):
            sources.append(resume_layout.tex(resume_layout.Layout(
                name='Fixture Rivéra', headline='Engineer', contact='fixture@example.test',
                font_size=size, template=template,
                sections=[resume_layout.Section(heading='Experience', text='Python', entries=[
                    resume_layout.Entry(title='Engineer', subtitle='Fixture', dates='2022 – Present',
                                        bullets=['Organized sample records.'])])])) )
    for index, source in enumerate(sources):
        path = target / f'warm-{index}.tex'
        path.write_text(source)
        subprocess.run(['tectonic', '-o', directory, str(path)], check=True)
    cover_letter_pdf('I am interested in this role.\n\nThank you for your consideration.',
                     {'full_name':'Fixture Example','email':'fixture@example.test'}, 'warm-cover')
