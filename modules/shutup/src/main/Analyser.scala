package lila.shutup

import lila.common.constants.bannedYoutubeIds

object Analyser {

  def apply(raw: String): TextAnalysis = lila.common.Chronometer
    .sync {
      val lower = raw.take(2000).toLowerCase
      TextAnalysis(
        lower,
        (
          latinBigRegex.findAllMatchIn(latinify(lower)).toList :::
            ruBigRegex.findAllMatchIn(lower).toList
        ).map(_.toString)
      )
    }
    .mon(_.shutup.analyzer)
    .logIfSlow(100, logger)(_ => s"Slow shutup analyser ${raw take 400}")
    .result

  def isCritical(raw: String) =
    criticalRegex.find(latinify(raw.toLowerCase))

  private val logger = lila log "security" branch "shutup"

  private def latinify(text: String): String =
    text map {
      case 'е' => 'e'
      case 'а' => 'a'
      case 'ı' => 'i'
      case 'у' => 'y'
      case 'х' => 'x'
      case 'к' => 'k'
      case 'Н' => 'h'
      case 'о' => 'o'
      case c   => c
    }

  private def latinWordsRegexes =
    Dictionary.en.map { word =>
      word + (if (word endsWith "e") "" else "e?+") + "[ds]?+"
    } ++
      Dictionary.es.map { word =>
        word + (if (word endsWith "e") "" else "e?+") + "s?+"
      } ++
      Dictionary.hi ++
      Dictionary.fr.map { word =>
        word + "[sx]?+"
      } ++
      Dictionary.de.map { word =>
        word + (if (word endsWith "e") "" else "e?+") + "[nrs]?+"
      } ++
      Dictionary.tr ++
      Dictionary.it ++
      bannedYoutubeIds

  private val latinBigRegex = {
    """(?i)\b""" +
      latinWordsRegexes.mkString("(", "|", ")") +
      """\b"""
  }.r

  private val ruBigRegex = {
    """(?iu)\b""" +
      Dictionary.ru.mkString("(", "|", ")") +
      """\b"""
  }.r

  private val criticalRegex = {
    """(?i)\b""" +
      Dictionary.critical.mkString("(", "|", ")") +
      """\b"""
  }.r
}
